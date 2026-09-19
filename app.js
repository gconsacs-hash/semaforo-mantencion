/* ============================================================================
   Semáforo Mantención — lógica de la app
   Flujo: se reporta un hallazgo con foto → queda en ROJO → cuando alguien lo
   toma pasa a AMARILLO (en trabajo) → al terminar pasa a VERDE (finalizado).
   Los datos viven en el teléfono (IndexedDB) y, si se activa, se sincronizan
   con el equipo a través de Firebase (plan gratuito).
   ============================================================================ */
'use strict';

const VERSION_APP = '1.0';
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ------------------------------------------------------------ constantes
const ESTADOS = {
  rojo:     { nombre: 'Reportado',  detalle: 'Pendiente: nadie lo ha tomado todavía', emoji: '🔴' },
  amarillo: { nombre: 'En trabajo', detalle: 'Se está reparando o interviniendo',      emoji: '🟡' },
  verde:    { nombre: 'Finalizado', detalle: 'Mejora u obra terminada',                emoji: '🟢' },
};
const CATEGORIAS = ['Pisos', 'Muros y pintura', 'Cielos', 'Puertas y ventanas', 'Eléctrico', 'Sanitario / agua',
  'Climatización', 'Gases clínicos', 'Equipamiento', 'Seguridad', 'Exteriores', 'Otro'];
const PRIORIDADES = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const ORDEN_PRIORIDAD = { alta: 0, media: 1, baja: 2 };

// ------------------------------------------------------------ utilidades
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem('sm.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set: (k, v) => localStorage.setItem('sm.' + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem('sm.' + k),
};
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dos = (n) => String(n).padStart(2, '0');
const fmtFecha = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${dos(d.getDate())}-${dos(d.getMonth() + 1)}-${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}`; };
const fmtDia = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${dos(d.getDate())}-${dos(d.getMonth() + 1)}-${d.getFullYear()}`; };
const fmtDiaISO = (iso) => iso ? iso.split('-').reverse().join('-') : '—';
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`; };
const diasDesde = (ms) => Math.floor((Date.now() - ms) / 86400000);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ubicacion = (h) => [h.sector, h.piso ? 'Piso ' + h.piso : '', h.recinto].filter(Boolean).join(' · ');
let toastTimer = null;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms); }

// ------------------------------------------------------------ estado en memoria
const S = {
  hallazgos: {},          // id → ficha
  vista: 'tablero',
  detalleId: null,
  filtro: { estado: '', texto: '', sector: '', categoria: '', prioridad: '', orden: 'reciente' },
  fotosNuevo: [],         // fotos pendientes del formulario nuevo/editar
  fotosAccion: [],        // fotos pendientes de la ventana de acción
  accion: null,           // { tipo:'estado'|'nota', nuevoEstado }
  fb: null,               // conexión Firebase { col, unsub }
  fbEstado: 'local',
  fbMsg: '',
  ajustes: Object.assign({ usuario: '', establecimiento: 'Hospital', diasAlerta: 3 }, LS.get('ajustes', {})),
};
const activos = () => Object.values(S.hallazgos).filter((h) => !h.eliminado);
const guardarAjustes = () => LS.set('ajustes', S.ajustes);

// ------------------------------------------------------------ persistencia de fichas
async function guardarHallazgo(h) {
  h.updatedAt = Date.now();
  S.hallazgos[h.id] = h;
  await DB.guardar('hallazgos', h);
  if (S.fb && S.fb.col) {
    S.fb.col.doc('h-' + h.id).set(h).catch((e) => { console.warn('firestore', e); setFb('err', 'Error al guardar en la nube: ' + (e.code || e.message)); });
  }
  render();
}

// ------------------------------------------------------------ fotos
// Cada foto se guarda dos veces: una miniatura pequeña dentro de la ficha (para las listas)
// y la imagen completa aparte (se descarga solo cuando se abre).
function cargarImagen(archivo) {
  return new Promise((resolver, rechazar) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolver(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rechazar(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}
function redimensionar(img, maximo, calidad) {
  const escala = Math.min(1, maximo / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * escala));
  c.height = Math.max(1, Math.round(img.height * escala));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', calidad);
}
async function procesarArchivo(archivo) {
  const img = await cargarImagen(archivo);
  let completa = redimensionar(img, 1280, 0.75);
  if (completa.length > 900000) completa = redimensionar(img, 1024, 0.6); // límite de Firestore: 1 MB por documento
  return { id: nuevoId(), completa, mini: redimensionar(img, 320, 0.6), fecha: Date.now() };
}
async function agregarArchivos(lista, destino, contenedor) {
  const archivos = Array.from(lista || []);
  if (!archivos.length) return;
  toast(archivos.length > 1 ? 'Procesando fotos…' : 'Procesando foto…', 1500);
  for (const a of archivos) {
    try { destino.push(await procesarArchivo(a)); } catch (e) { toast('No se pudo leer una imagen'); }
  }
  renderPreviews(destino, contenedor);
}
function renderPreviews(fotos, contenedor) {
  contenedor.innerHTML = fotos.map((f, i) => `<div class="prev" style="background-image:url(${f.mini})"><button type="button" data-i="${i}" title="Quitar">✕</button></div>`).join('');
  contenedor.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { fotos.splice(+b.dataset.i, 1); renderPreviews(fotos, contenedor); }));
}
async function guardarFotosPendientes(h, pendientes, etapa) {
  const ids = [];
  for (const f of pendientes) {
    await DB.guardar('fotos', { id: f.id, hallazgoId: h.id, data: f.completa, fecha: f.fecha, subida: false });
    h.fotos.push({ id: f.id, mini: f.mini, fecha: f.fecha, etapa });
    ids.push(f.id);
  }
  pendientes.length = 0;
  subirFotosPendientes();
  return ids;
}
async function obtenerFoto(id) {
  const local = await DB.obtener('fotos', id);
  if (local) return local.data;
  if (S.fb && S.fb.col) {
    try {
      const doc = await S.fb.col.doc('f-' + id).get();
      if (doc.exists) { const f = doc.data(); await DB.guardar('fotos', { id, hallazgoId: f.hallazgoId, data: f.data, fecha: f.fecha, subida: true }); return f.data; }
    } catch (e) { console.warn('foto nube', e); }
  }
  return null;
}
let subiendo = false;
async function subirFotosPendientes() {
  if (!S.fb || !S.fb.col || subiendo) return;
  subiendo = true;
  try {
    const fotos = (await DB.todos('fotos')).filter((f) => !f.subida);
    for (const f of fotos) {
      if (!S.fb || !S.fb.col) break;
      const h = S.hallazgos[f.hallazgoId];
      if (!h || h.eliminado) { f.subida = true; await DB.guardar('fotos', f); continue; }
      await S.fb.col.doc('f-' + f.id).set({ id: f.id, hallazgoId: f.hallazgoId, data: f.data, fecha: f.fecha, updatedAt: Date.now() });
      f.subida = true; await DB.guardar('fotos', f);
    }
  } catch (e) { console.warn('subida fotos', e); }
  subiendo = false;
}
function abrirVisor(mini, id, texto) {
  const dlg = $('#dlgFoto'); const img = $('#visorImg');
  img.src = mini; $('#visorTexto').textContent = texto || '';
  dlg.showModal();
  obtenerFoto(id).then((data) => { if (data && dlg.open) img.src = data; });
}

// ------------------------------------------------------------ navegación
function irA(vista) {
  S.vista = vista;
  $$('.vista').forEach((v) => v.classList.toggle('activa', v.id === 'v-' + vista));
  $$('.menu button').forEach((b) => b.classList.toggle('activa', b.dataset.vista === vista || (vista === 'detalle' && b.dataset.vista === 'tablero')));
  window.scrollTo(0, 0);
  if (vista === 'informes') renderInformes();
  if (vista === 'ajustes') renderAjustes();
  if (vista === 'nuevo' && !$('#nId').value) prepararFormulario(null);
}

// ------------------------------------------------------------ tablero
function listaFiltrada() {
  const f = S.filtro; const t = f.texto.trim().toLowerCase();
  let lista = activos().filter((h) =>
    (!f.estado || h.estado === f.estado) &&
    (!f.sector || h.sector === f.sector) &&
    (!f.categoria || h.categoria === f.categoria) &&
    (!f.prioridad || h.prioridad === f.prioridad) &&
    (!t || [h.titulo, h.descripcion, h.sector, h.piso, h.recinto, h.responsable, h.reportadoPor, h.categoria].join(' ').toLowerCase().includes(t))
  );
  const orden = {
    reciente: (a, b) => b.creadoEn - a.creadoEn,
    antiguo: (a, b) => a.creadoEn - b.creadoEn,
    prioridad: (a, b) => (ORDEN_PRIORIDAD[a.prioridad] - ORDEN_PRIORIDAD[b.prioridad]) || (a.creadoEn - b.creadoEn),
    plazo: (a, b) => (a.plazo || '9999') < (b.plazo || '9999') ? -1 : 1,
  }[f.orden] || ((a, b) => b.creadoEn - a.creadoEn);
  return lista.sort(orden);
}
const vencido = (h) => h.estado !== 'verde' && h.plazo && h.plazo < hoyISO();
const sinAtender = (h) => h.estado === 'rojo' && diasDesde(h.creadoEn) >= (+S.ajustes.diasAlerta || 3);

function renderTablero() {
  const todos = activos();
  // luces del semáforo
  $$('#semaforo .luz').forEach((b) => {
    const n = todos.filter((h) => h.estado === b.dataset.estado).length;
    b.querySelector('b').textContent = n;
    b.classList.toggle('con-datos', n > 0);
    b.classList.toggle('activa', S.filtro.estado === b.dataset.estado);
  });
  // alertas
  const vencidos = todos.filter(vencido), viejos = todos.filter((h) => sinAtender(h) && !vencido(h));
  $('#alertas').innerHTML =
    (vencidos.length ? `<div class="alerta grave" data-alerta="vencidos">⏰ <b>${vencidos.length}</b> hallazgo${vencidos.length > 1 ? 's' : ''} con plazo vencido sin finalizar</div>` : '') +
    (viejos.length ? `<div class="alerta" data-alerta="viejos">⚠️ <b>${viejos.length}</b> en rojo hace más de ${S.ajustes.diasAlerta} días sin que nadie lo tome</div>` : '');
  // selectores de filtro (con los valores que existen)
  llenarSelect($('#fSector'), [...new Set(todos.map((h) => h.sector).filter(Boolean))].sort(), S.filtro.sector, 'Todos los sectores');
  llenarSelect($('#fCategoria'), [...new Set([...CATEGORIAS, ...todos.map((h) => h.categoria)].filter(Boolean))], S.filtro.categoria, 'Todas las categorías');
  const hayFiltro = S.filtro.estado || S.filtro.texto || S.filtro.sector || S.filtro.categoria || S.filtro.prioridad;
  $('#fLimpiar').hidden = !hayFiltro;
  // lista
  const lista = listaFiltrada();
  $('#listaVacia').hidden = lista.length > 0;
  $('#lista').innerHTML = lista.map((h) => {
    const dias = diasDesde(h.creadoEn);
    const foto = h.fotos[0];
    return `<button type="button" class="item ${h.estado}" data-id="${h.id}">
      <div class="mini" ${foto ? `style="background-image:url(${foto.mini})"` : ''}>${foto ? '' : '📷'}</div>
      <div>
        <div class="titulo"><span class="punto ${h.estado}"></span>${esc(h.titulo)}</div>
        <div class="meta">📍 ${esc(ubicacion(h)) || 'Sin ubicación'}</div>
        <div class="meta">${esc(h.categoria)} · ${ESTADOS[h.estado].nombre}${h.responsable && h.estado !== 'rojo' ? ' · ' + esc(h.responsable) : ''}</div>
        <div class="meta" style="margin-top:4px">
          <span class="chip ${h.prioridad}">${PRIORIDADES[h.prioridad]}</span>
          <span class="chip dias">${h.estado === 'verde' ? 'Cerrado ' + fmtDia(h.finEn) : dias === 0 ? 'Hoy' : 'Hace ' + dias + ' d'}</span>
          ${vencido(h) ? '<span class="chip vencido">Plazo vencido</span>' : sinAtender(h) ? '<span class="chip vencido">Sin atender</span>' : ''}
        </div>
      </div>
    </button>`;
  }).join('');
}
function llenarSelect(sel, valores, actual, textoTodos) {
  sel.innerHTML = `<option value="">${textoTodos}</option>` + valores.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = valores.includes(actual) ? actual : '';
}

// ------------------------------------------------------------ nuevo / editar
function llenarDatalists() {
  const todos = activos();
  const unicos = (campo) => [...new Set(todos.map((h) => h[campo]).filter(Boolean))].sort();
  const opciones = (arr) => arr.map((v) => `<option value="${esc(v)}">`).join('');
  $('#dlSector').innerHTML = opciones(unicos('sector'));
  $('#dlPiso').innerHTML = opciones(unicos('piso'));
  $('#dlRecinto').innerHTML = opciones(unicos('recinto'));
  $('#dlResponsable').innerHTML = opciones(unicos('responsable'));
}
function prepararFormulario(h) {
  llenarDatalists();
  $('#nCategoria').innerHTML = CATEGORIAS.map((c) => `<option>${c}</option>`).join('');
  S.fotosNuevo = []; renderPreviews(S.fotosNuevo, $('#nPreview'));
  $('#nId').value = h ? h.id : '';
  $('#nuevoTitulo').textContent = h ? 'Editar hallazgo' : 'Nuevo hallazgo';
  $('#btnGuardarNuevo').textContent = h ? '💾 Guardar cambios' : '🚨 Reportar en rojo';
  $('#nTitulo').value = h ? h.titulo : '';
  $('#nCategoria').value = h ? h.categoria : 'Pisos';
  $('#nPrioridad').value = h ? h.prioridad : 'media';
  $('#nSector').value = h ? h.sector : '';
  $('#nPiso').value = h ? h.piso : '';
  $('#nRecinto').value = h ? h.recinto : '';
  $('#nDescripcion').value = h ? h.descripcion : '';
  $('#nResponsable').value = h ? h.responsable : '';
  $('#nPlazo').value = h ? h.plazo : '';
  $('#nReportadoPor').value = h ? h.reportadoPor : S.ajustes.usuario;
}
async function enviarFormulario(e) {
  e.preventDefault();
  const id = $('#nId').value;
  const datos = {
    titulo: $('#nTitulo').value.trim(), categoria: $('#nCategoria').value, prioridad: $('#nPrioridad').value,
    sector: $('#nSector').value.trim(), piso: $('#nPiso').value.trim(), recinto: $('#nRecinto').value.trim(),
    descripcion: $('#nDescripcion').value.trim(), responsable: $('#nResponsable').value.trim(), plazo: $('#nPlazo').value,
    reportadoPor: $('#nReportadoPor').value.trim(),
  };
  if (!datos.titulo) { toast('Escribe qué se encontró'); return; }
  if (datos.reportadoPor && datos.reportadoPor !== S.ajustes.usuario) { S.ajustes.usuario = datos.reportadoPor; guardarAjustes(); }
  const btn = $('#btnGuardarNuevo'); btn.disabled = true;
  try {
    let h;
    if (id && S.hallazgos[id]) {
      h = S.hallazgos[id]; Object.assign(h, datos);
      const ids = await guardarFotosPendientes(h, S.fotosNuevo, h.estado);
      h.historial.push({ fecha: Date.now(), tipo: 'editado', estado: h.estado, nota: 'Ficha editada', por: S.ajustes.usuario, fotoIds: ids });
      await guardarHallazgo(h);
      toast('Cambios guardados');
      abrirDetalle(h.id);
    } else {
      h = Object.assign({ id: nuevoId(), estado: 'rojo', creadoEn: Date.now(), inicioEn: null, finEn: null, fotos: [], historial: [], eliminado: false }, datos);
      const ids = await guardarFotosPendientes(h, S.fotosNuevo, 'rojo');
      h.historial.push({ fecha: h.creadoEn, tipo: 'creado', estado: 'rojo', nota: 'Hallazgo reportado', por: h.reportadoPor, fotoIds: ids });
      await guardarHallazgo(h);
      toast('🔴 Hallazgo reportado en rojo');
      $('#nId').value = '';
      abrirDetalle(h.id);
    }
  } finally { btn.disabled = false; }
}

// ------------------------------------------------------------ detalle
function abrirDetalle(id) { S.detalleId = id; irA('detalle'); renderDetalle(); }
function renderDetalle() {
  const h = S.hallazgos[S.detalleId];
  if (!h || h.eliminado) { irA('tablero'); return; }
  const est = ESTADOS[h.estado];
  const pasos = ['rojo', 'amarillo', 'verde']; const idx = pasos.indexOf(h.estado);
  const dias = h.estado === 'verde' ? Math.max(0, Math.floor(((h.finEn || Date.now()) - h.creadoEn) / 86400000)) : diasDesde(h.creadoEn);
  const botones = {
    rojo: [['amarillo', '🟡 Iniciar trabajo', 'amarillo'], ['verde', '🟢 Marcar finalizado', 'verde']],
    amarillo: [['verde', '🟢 Marcar finalizado', 'verde'], ['rojo', '🔴 Volver a pendiente', 'rojo']],
    verde: [['rojo', '🔴 Reabrir (el problema volvió)', 'rojo']],
  }[h.estado];
  const fotoMini = (id) => { const f = h.fotos.find((x) => x.id === id); return f ? `<div class="foto" data-foto="${f.id}" style="background-image:url(${f.mini})"></div>` : ''; };
  $('#detalle').innerHTML = `
    <div class="estado-banner ${h.estado}">
      <b>${est.emoji} ${est.nombre}</b><small>${est.detalle}</small>
      <div class="pasos">${pasos.map((p, i) => `<i class="${i <= idx ? 'hecho' : ''}"></i>`).join('')}</div>
      <small>${h.estado === 'verde' ? `Resuelto en ${dias} día${dias === 1 ? '' : 's'}` : `Abierto hace ${dias} día${dias === 1 ? '' : 's'}`}${vencido(h) ? ' · ⏰ plazo vencido' : ''}</small>
    </div>
    <div class="acciones-estado">
      ${botones.map(([e, t, c]) => `<button type="button" class="btn ${c}" data-estado="${e}">${t}</button>`).join('')}
      <button type="button" class="btn" id="btnNota">📝 Agregar nota / foto</button>
      <button type="button" class="btn" id="btnCompartir">📤 Compartir (WhatsApp, correo…)</button>
    </div>
    <div class="tarjeta">
      <h3>${esc(h.titulo)}</h3>
      ${h.descripcion ? `<p>${esc(h.descripcion).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="campos">
        <div class="ancho"><small>Ubicación</small>📍 ${esc(ubicacion(h)) || '—'}</div>
        <div><small>Categoría</small>${esc(h.categoria)}</div>
        <div><small>Prioridad</small><span class="chip ${h.prioridad}">${PRIORIDADES[h.prioridad]}</span></div>
        <div><small>Reportado por</small>${esc(h.reportadoPor) || '—'}</div>
        <div><small>Fecha reporte</small>${fmtFecha(h.creadoEn)}</div>
        <div><small>Responsable</small>${esc(h.responsable) || '—'}</div>
        <div><small>Plazo</small>${fmtDiaISO(h.plazo)}</div>
        <div><small>Inicio trabajo</small>${fmtFecha(h.inicioEn)}</div>
        <div><small>Término</small>${fmtFecha(h.finEn)}</div>
      </div>
    </div>
    <div class="tarjeta">
      <h3>Fotos (${h.fotos.length})</h3>
      ${h.fotos.length ? `<div class="galeria">${h.fotos.map((f) => `<figure><div class="foto" data-foto="${f.id}" style="background-image:url(${f.mini})"></div><figcaption>${ESTADOS[f.etapa] ? ESTADOS[f.etapa].emoji + ' ' + ESTADOS[f.etapa].nombre : ''} · ${fmtDia(f.fecha)}</figcaption></figure>`).join('')}</div>` : '<p class="ayuda">Sin fotos. Usa "Agregar nota / foto".</p>'}
    </div>
    <div class="tarjeta">
      <h3>Historial</h3>
      <ul class="historial">${h.historial.slice().reverse().map((e) => `<li>
        <span class="punto ${e.estado}"></span>
        <div><b>${e.tipo === 'estado' ? 'Pasó a ' + ESTADOS[e.estado].nombre : e.tipo === 'creado' ? 'Reportado' : e.tipo === 'editado' ? 'Ficha editada' : 'Nota'}</b>${e.nota && e.tipo !== 'editado' && e.tipo !== 'creado' ? ': ' + esc(e.nota) : ''}
          <small>${fmtFecha(e.fecha)}${e.por ? ' · ' + esc(e.por) : ''}</small>
          ${(e.fotoIds || []).length ? `<div class="fotos-nota">${e.fotoIds.map(fotoMini).join('')}</div>` : ''}
        </div></li>`).join('')}</ul>
    </div>`;
  $('#detalle').querySelectorAll('[data-estado]').forEach((b) => b.addEventListener('click', () => abrirAccion('estado', b.dataset.estado)));
  $('#btnNota').addEventListener('click', () => abrirAccion('nota'));
  $('#btnCompartir').addEventListener('click', () => compartirHallazgo(h));
  $('#detalle').querySelectorAll('[data-foto]').forEach((el) => el.addEventListener('click', () => {
    const f = h.fotos.find((x) => x.id === el.dataset.foto);
    abrirVisor(f.mini, f.id, `${h.titulo} · ${ESTADOS[f.etapa] ? ESTADOS[f.etapa].nombre : ''} · ${fmtFecha(f.fecha)}`);
  }));
}

// ventana de acción (cambio de estado o nota)
function abrirAccion(tipo, nuevoEstado) {
  const h = S.hallazgos[S.detalleId];
  S.accion = { tipo, nuevoEstado };
  S.fotosAccion = []; renderPreviews(S.fotosAccion, $('#accPreview'));
  $('#accNota').value = '';
  $('#accResponsable').value = h.responsable || '';
  $('#accLblResponsable').hidden = !(tipo === 'estado' && nuevoEstado === 'amarillo');
  const textos = {
    amarillo: ['🟡 Iniciar trabajo', 'El hallazgo pasa a amarillo: alguien lo está atendiendo. Puedes agregar una foto del inicio.'],
    verde: ['🟢 Marcar finalizado', 'El hallazgo pasa a verde. Se recomienda una foto del trabajo terminado como respaldo.'],
    rojo: ['🔴 Volver a rojo', 'El hallazgo vuelve a pendiente. Indica el motivo.'],
  };
  const [t, d] = tipo === 'estado' ? textos[nuevoEstado] : ['📝 Agregar nota / foto', 'Se agrega al historial sin cambiar el estado.'];
  $('#accTitulo').textContent = t; $('#accTexto').textContent = d;
  $('#accConfirmar').className = 'btn ' + (tipo === 'estado' ? nuevoEstado : 'primario');
  $('#accConfirmar').textContent = tipo === 'estado' ? 'Confirmar cambio' : 'Guardar';
  llenarDatalists();
  $('#dlgAccion').showModal();
}
async function confirmarAccion(e) {
  e.preventDefault();
  const h = S.hallazgos[S.detalleId]; const a = S.accion; if (!h || !a) return;
  const nota = $('#accNota').value.trim();
  if (a.tipo === 'nota' && !nota && !S.fotosAccion.length) { toast('Escribe una nota o agrega una foto'); return; }
  $('#accConfirmar').disabled = true;
  try {
    const etapa = a.tipo === 'estado' ? a.nuevoEstado : h.estado;
    const ids = await guardarFotosPendientes(h, S.fotosAccion, etapa);
    const ahora = Date.now();
    if (a.tipo === 'estado') {
      h.estado = a.nuevoEstado;
      if (a.nuevoEstado === 'amarillo') { h.inicioEn = h.inicioEn || ahora; h.finEn = null; const r = $('#accResponsable').value.trim(); if (r) h.responsable = r; }
      if (a.nuevoEstado === 'verde') { h.inicioEn = h.inicioEn || ahora; h.finEn = ahora; }
      if (a.nuevoEstado === 'rojo') { h.finEn = null; }
    }
    h.historial.push({ fecha: ahora, tipo: a.tipo, estado: etapa, nota, por: S.ajustes.usuario, fotoIds: ids });
    await guardarHallazgo(h);
    $('#dlgAccion').close();
    toast(a.tipo === 'estado' ? `${ESTADOS[a.nuevoEstado].emoji} Ahora está ${ESTADOS[a.nuevoEstado].nombre.toLowerCase()}` : 'Nota agregada');
    renderDetalle();
  } finally { $('#accConfirmar').disabled = false; }
}
async function eliminarHallazgo() {
  const h = S.hallazgos[S.detalleId]; if (!h) return;
  if (!confirm(`¿Eliminar "${h.titulo}"? Desaparece para todo el equipo.`)) return;
  h.eliminado = true;
  await guardarHallazgo(h);
  for (const f of h.fotos) { try { await DB.borrar('fotos', f.id); } catch (e) {} }
  toast('Hallazgo eliminado');
  irA('tablero');
}
function textoHallazgo(h) {
  const est = ESTADOS[h.estado];
  return [`${est.emoji} ${est.nombre.toUpperCase()} — ${h.titulo}`, `📍 ${ubicacion(h) || 'Sin ubicación'}`,
    `Categoría: ${h.categoria} · Prioridad: ${PRIORIDADES[h.prioridad]}`, h.descripcion ? h.descripcion : '',
    `Reportado: ${fmtFecha(h.creadoEn)}${h.reportadoPor ? ' por ' + h.reportadoPor : ''}`,
    h.responsable ? `Responsable: ${h.responsable}` : '', h.plazo ? `Plazo: ${fmtDiaISO(h.plazo)}` : '',
    h.finEn ? `Finalizado: ${fmtFecha(h.finEn)}` : '', `(${S.ajustes.establecimiento} · Semáforo Mantención)`].filter(Boolean).join('\n');
}
async function compartirHallazgo(h) {
  const texto = textoHallazgo(h);
  const archivos = [];
  if (h.fotos[0]) { const data = await obtenerFoto(h.fotos[0].id) || h.fotos[0].mini; archivos.push(dataUrlAArchivo(data, 'hallazgo.jpg')); }
  if (navigator.share) {
    try {
      if (archivos.length && navigator.canShare && navigator.canShare({ files: archivos })) await navigator.share({ title: h.titulo, text: texto, files: archivos });
      else await navigator.share({ title: h.titulo, text: texto });
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
}
function dataUrlAArchivo(dataUrl, nombre) {
  const [cab, b64] = dataUrl.split(','); const tipo = (cab.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], nombre, { type: tipo });
}

// ------------------------------------------------------------ informes y exportación
function renderInformes() {
  const todos = activos();
  const n = (e) => todos.filter((h) => h.estado === e).length;
  const cerrados = todos.filter((h) => h.estado === 'verde' && h.finEn);
  const promedio = cerrados.length ? (cerrados.reduce((a, h) => a + (h.finEn - h.creadoEn), 0) / cerrados.length / 86400000).toFixed(1) : '—';
  $('#resumen').innerHTML = `
    <div><b style="color:var(--rojo)">${n('rojo')}</b><small>Reportados</small></div>
    <div><b style="color:var(--amarillo)">${n('amarillo')}</b><small>En trabajo</small></div>
    <div><b style="color:var(--verde)">${n('verde')}</b><small>Finalizados</small></div>
    <div><b>${todos.length}</b><small>Total</small></div>
    <div><b>${todos.filter(vencido).length}</b><small>Plazo vencido</small></div>
    <div><b>${promedio}</b><small>Días promedio en resolver</small></div>`;
  const tabla = (campo) => {
    const grupos = {};
    todos.forEach((h) => { const k = h[campo] || 'Sin dato'; grupos[k] = grupos[k] || { rojo: 0, amarillo: 0, verde: 0 }; grupos[k][h.estado]++; });
    const filas = Object.entries(grupos).sort((a, b) => (b[1].rojo + b[1].amarillo) - (a[1].rojo + a[1].amarillo));
    return filas.length ? `<table><tr><th></th><th class="n">🔴</th><th class="n">🟡</th><th class="n">🟢</th></tr>${filas.map(([k, g]) => `<tr><td>${esc(k)}</td><td class="n r">${g.rojo}</td><td class="n a">${g.amarillo}</td><td class="n v">${g.verde}</td></tr>`).join('')}</table>` : '<p class="ayuda">Aún no hay datos.</p>';
  };
  $('#tablaSector').innerHTML = tabla('sector');
  $('#tablaCategoria').innerHTML = tabla('categoria');
}
async function entregarArchivo(nombre, contenido, tipo, compartir) {
  const blob = new Blob([contenido], { type: tipo });
  if (compartir && navigator.share) {
    const archivo = new File([blob], nombre, { type: tipo });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: nombre }); return; } catch (e) { if (e.name === 'AbortError') return; }
    } else toast('Este navegador no permite compartir archivos: se descargará');
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Archivo descargado: ' + nombre);
}
const nombreArchivo = (base, ext) => `${base}_${hoyISO()}.${ext}`;

function generarCSV() {
  const cab = ['ID', 'Estado', 'Título', 'Categoría', 'Prioridad', 'Sector', 'Piso', 'Recinto', 'Reportado por', 'Responsable', 'Fecha reporte', 'Inicio trabajo', 'Término', 'Plazo', 'Plazo vencido', 'Días abierto', 'N° fotos', 'Descripción', 'Última nota'];
  const celda = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const filas = activos().sort((a, b) => a.creadoEn - b.creadoEn).map((h) => {
    const dias = Math.floor(((h.estado === 'verde' && h.finEn ? h.finEn : Date.now()) - h.creadoEn) / 86400000);
    const ultima = h.historial.slice().reverse().find((e) => e.nota && e.tipo !== 'editado' && e.tipo !== 'creado');
    return [h.id, ESTADOS[h.estado].nombre, h.titulo, h.categoria, PRIORIDADES[h.prioridad], h.sector, h.piso, h.recinto, h.reportadoPor, h.responsable,
      fmtFecha(h.creadoEn), h.inicioEn ? fmtFecha(h.inicioEn) : '', h.finEn ? fmtFecha(h.finEn) : '', fmtDiaISO(h.plazo).replace('—', ''), vencido(h) ? 'Sí' : 'No', dias, h.fotos.length, h.descripcion, ultima ? ultima.nota : ''].map(celda).join(';');
  });
  return '﻿' + [cab.map(celda).join(';'), ...filas].join('\r\n');
}
async function generarInforme() {
  const soloAbiertos = $('#infSoloAbiertos').checked, grandes = $('#infFotosGrandes').checked;
  let lista = activos().filter((h) => !soloAbiertos || h.estado !== 'verde');
  lista.sort((a, b) => (ORDEN_PRIORIDAD[a.prioridad] - ORDEN_PRIORIDAD[b.prioridad]) || ({ rojo: 0, amarillo: 1, verde: 2 }[a.estado] - { rojo: 0, amarillo: 1, verde: 2 }[b.estado]) || (a.creadoEn - b.creadoEn));
  const n = (e) => lista.filter((h) => h.estado === e).length;
  const color = { rojo: '#d93025', amarillo: '#f2a900', verde: '#188038' };
  const fotosHtml = async (h) => {
    const partes = [];
    for (const f of h.fotos) {
      const src = grandes ? (await obtenerFoto(f.id)) || f.mini : f.mini;
      partes.push(`<figure><img src="${src}" alt=""><figcaption>${ESTADOS[f.etapa] ? ESTADOS[f.etapa].emoji + ' ' + ESTADOS[f.etapa].nombre : ''} · ${fmtDia(f.fecha)}</figcaption></figure>`);
    }
    return partes.join('');
  };
  const tarjetas = [];
  for (const h of lista) {
    tarjetas.push(`<article class="h" style="border-left-color:${color[h.estado]}">
      <header><span class="est" style="background:${color[h.estado]}">${ESTADOS[h.estado].nombre}</span> <b>${esc(h.titulo)}</b> <span class="pr">Prioridad ${PRIORIDADES[h.prioridad]}</span></header>
      <div class="meta">📍 ${esc(ubicacion(h)) || 'Sin ubicación'} · ${esc(h.categoria)}</div>
      ${h.descripcion ? `<p>${esc(h.descripcion).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="meta">Reportado ${fmtFecha(h.creadoEn)}${h.reportadoPor ? ' por ' + esc(h.reportadoPor) : ''}${h.responsable ? ' · Responsable: ' + esc(h.responsable) : ''}${h.plazo ? ' · Plazo: ' + fmtDiaISO(h.plazo) + (vencido(h) ? ' <b style="color:#d93025">(VENCIDO)</b>' : '') : ''}${h.inicioEn ? ' · Inicio: ' + fmtFecha(h.inicioEn) : ''}${h.finEn ? ' · Término: ' + fmtFecha(h.finEn) : ''}</div>
      <div class="fotos">${await fotosHtml(h)}</div>
      <ul>${h.historial.map((e) => `<li><span style="color:${color[e.estado] || '#666'}">●</span> ${fmtFecha(e.fecha)} — ${e.tipo === 'estado' ? 'Pasó a ' + ESTADOS[e.estado].nombre : e.tipo === 'creado' ? 'Reportado' : e.tipo === 'editado' ? 'Ficha editada' : 'Nota'}${e.nota && e.tipo !== 'creado' && e.tipo !== 'editado' ? ': ' + esc(e.nota) : ''}${e.por ? ' (' + esc(e.por) + ')' : ''}</li>`).join('')}</ul>
    </article>`);
  }
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe de hallazgos — ${esc(S.ajustes.establecimiento)} — ${fmtDia(Date.now())}</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:20px;color:#1f2937;background:#fff;max-width:900px;margin:auto}
h1{font-size:1.4rem;margin:0}.sub{color:#6b7280;margin-bottom:16px}
.res{display:flex;gap:10px;margin:14px 0}.res div{flex:1;border-radius:8px;padding:10px;text-align:center;color:#fff}.res b{display:block;font-size:1.6rem}
.h{border:1px solid #e5e7eb;border-left:6px solid #999;border-radius:8px;padding:12px;margin-bottom:14px;page-break-inside:avoid}
.h header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:1.05rem}.est{color:#fff;border-radius:999px;padding:2px 10px;font-size:.75rem;font-weight:600}
.pr{font-size:.75rem;color:#6b7280;margin-left:auto}.meta{font-size:.85rem;color:#6b7280;margin:4px 0}
.fotos{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.fotos figure{margin:0;width:${grandes ? '260px' : '160px'}}.fotos img{width:100%;border-radius:6px;display:block}
figcaption{font-size:.7rem;color:#6b7280;text-align:center}ul{font-size:.8rem;color:#374151;padding-left:18px;margin:6px 0 0}
@media print{body{padding:0}.h{box-shadow:none}}
</style></head><body>
<h1>🚦 Informe de hallazgos de mantención</h1>
<div class="sub">${esc(S.ajustes.establecimiento)} · generado el ${fmtFecha(Date.now())}${soloAbiertos ? ' · solo pendientes y en trabajo' : ''}</div>
<div class="res"><div style="background:#d93025"><b>${n('rojo')}</b>Reportados</div><div style="background:#f2a900;color:#1f2937"><b>${n('amarillo')}</b>En trabajo</div><div style="background:#188038"><b>${n('verde')}</b>Finalizados</div></div>
${tarjetas.join('') || '<p>No hay hallazgos para mostrar.</p>'}
<p class="sub" style="margin-top:20px">Semáforo Mantención · ${lista.length} hallazgo${lista.length === 1 ? '' : 's'}</p>
</body></html>`;
}
async function generarRespaldo() {
  const fotos = (await DB.todos('fotos')).map((f) => ({ id: f.id, hallazgoId: f.hallazgoId, data: f.data, fecha: f.fecha }));
  return JSON.stringify({ app: 'semaforo-mantencion', version: VERSION_APP, exportado: Date.now(), establecimiento: S.ajustes.establecimiento, hallazgos: Object.values(S.hallazgos), fotos });
}
async function importarRespaldo(archivo) {
  let datos;
  try { datos = JSON.parse(await archivo.text()); } catch (e) { toast('El archivo no es un respaldo válido'); return; }
  if (!datos || datos.app !== 'semaforo-mantencion' || !Array.isArray(datos.hallazgos)) { toast('El archivo no es un respaldo de esta app'); return; }
  let nuevos = 0;
  for (const h of datos.hallazgos) {
    const local = S.hallazgos[h.id];
    if (!local || (h.updatedAt || 0) > (local.updatedAt || 0)) { S.hallazgos[h.id] = h; await DB.guardar('hallazgos', h); nuevos++; if (S.fb && S.fb.col) S.fb.col.doc('h-' + h.id).set(h).catch(() => {}); }
  }
  for (const f of datos.fotos || []) { if (!(await DB.obtener('fotos', f.id))) await DB.guardar('fotos', { id: f.id, hallazgoId: f.hallazgoId, data: f.data, fecha: f.fecha, subida: false }); }
  subirFotosPendientes();
  render();
  toast(`Respaldo restaurado: ${nuevos} ficha${nuevos === 1 ? '' : 's'} actualizada${nuevos === 1 ? '' : 's'}`);
}

// ------------------------------------------------------------ ajustes
function renderAjustes() {
  $('#ajUsuario').value = S.ajustes.usuario;
  $('#ajEstablecimiento').value = S.ajustes.establecimiento;
  $('#ajDiasAlerta').value = S.ajustes.diasAlerta;
  const fb = LS.get('fb');
  if (fb) { $('#ajClave').value = fb.clave; $('#ajFbConfig').value = fb.configTexto || ''; }
  else if (!$('#ajClave').value) $('#ajClave').value = 'equipo-' + Math.random().toString(36).slice(2, 8);
  renderSync();
  $('#btnNotif').textContent = !('Notification' in window) ? 'Este navegador no admite notificaciones' : Notification.permission === 'granted' ? '🔔 Notificaciones activadas' : Notification.permission === 'denied' ? '🔕 Bloqueadas (actívalas en ajustes del navegador)' : '🔔 Activar notificaciones';
  const todos = activos();
  $('#ajResumenDatos').textContent = `${todos.length} hallazgo${todos.length === 1 ? '' : 's'} y ${todos.reduce((a, h) => a + h.fotos.length, 0)} fotos guardados en este dispositivo.`;
  $('#version').textContent = VERSION_APP;
}
function renderSync() {
  const el = $('#syncEstado'); if (!el) return;
  const fb = LS.get('fb');
  el.innerHTML = S.fbEstado === 'on' ? `🟢 <b>Sincronizado</b> con la clave <code>${esc(fb ? fb.clave : '')}</code>. ${esc(S.fbMsg)}`
    : S.fbEstado === 'connecting' ? '🟡 Conectando…'
    : S.fbEstado === 'err' ? `🔴 <b>Error:</b> ${esc(S.fbMsg)}`
    : '⚪ Sin sincronizar: los datos están solo en este dispositivo.';
  $('#btnDesconectar').disabled = !fb;
}

// ---- Firebase (mismo esquema que la app Rumbo: spaces/{clave}/docs/{id})
// El apiKey es un identificador público; la seguridad la dan las reglas de Firestore.
const FB_DEFAULT = { apiKey: 'AIzaSyDmeaIi8ywuhr2CsADVgNwScnX-He8LSmo', authDomain: 'rumbo-3ba8c.firebaseapp.com', projectId: 'rumbo-3ba8c', appId: '1:6067423345:web:a266fd90967dbbf73673d0' };
const FB_SDK = ['https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js', 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'];
function cargarScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Sin conexión: no se pudo cargar Firebase')); document.head.appendChild(s); }); }
function setFb(estado, msg) {
  S.fbEstado = estado; S.fbMsg = msg || '';
  const el = $('#btnSync'); el.className = 'sync ' + (estado === 'on' ? 'on' : estado === 'err' ? 'err' : estado === 'connecting' ? 'connecting' : 'local');
  el.querySelector('span').textContent = estado === 'on' ? 'Sincronizado' : estado === 'err' ? 'Error' : estado === 'connecting' ? 'Conectando…' : 'Solo aquí';
  renderSync();
}
function parseFbConfig(txt) {
  const out = {}; const re = /(\w+)\s*:\s*["']([^"']+)["']/g; let m; while ((m = re.exec(txt))) out[m[1]] = m[2];
  if (!out.apiKey || !out.projectId || !out.appId) return null;
  return { apiKey: out.apiKey, authDomain: out.authDomain || out.projectId + '.firebaseapp.com', projectId: out.projectId, appId: out.appId };
}
async function conectarFb() {
  const cfg = LS.get('fb'); if (!cfg || !cfg.clave) return;
  if (S.fb && S.fb.unsub) { S.fb.unsub(); S.fb = null; } // evitar suscripciones duplicadas
  setFb('connecting');
  try {
    for (const s of FB_SDK) await cargarScript(s);
    if (!firebase.apps.length) firebase.initializeApp(cfg.config || FB_DEFAULT);
    const auth = firebase.auth(); const fs = firebase.firestore();
    try { await fs.enablePersistence({ synchronizeTabs: true }); } catch (e) {}
    if (!auth.currentUser) await auth.signInAnonymously();
    const col = fs.collection('spaces').doc(cfg.clave).collection('docs');
    S.fb = { col, unsub: null };
    const idDoc = firebase.firestore.FieldPath.documentId();
    let primera = true;
    // Solo se escuchan las fichas (h-…); las fotos (f-…) se bajan cuando se necesitan.
    S.fb.unsub = col.where(idDoc, '>=', 'h-').where(idDoc, '<', 'h.').onSnapshot(async (snap) => {
      let cambio = false; const nuevosRojos = [];
      for (const d of snap.docs) {
        const r = d.data(); const l = S.hallazgos[r.id];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) {
          if (!primera && !l && r.estado === 'rojo' && !r.eliminado && r.reportadoPor !== S.ajustes.usuario) nuevosRojos.push(r);
          S.hallazgos[r.id] = r; await DB.guardar('hallazgos', r); cambio = true;
        }
      }
      if (primera) { // subir lo local que la nube no tiene o tiene más viejo
        primera = false;
        Object.values(S.hallazgos).forEach((l) => { const rd = snap.docs.find((x) => x.id === 'h-' + l.id); if (!rd || (l.updatedAt || 0) > (rd.data().updatedAt || 0)) col.doc('h-' + l.id).set(l).catch(() => {}); });
        subirFotosPendientes();
      }
      if (cambio) render();
      nuevosRojos.forEach((h) => notificar('🔴 Nuevo hallazgo: ' + h.titulo, (ubicacion(h) || 'Sin ubicación') + (h.reportadoPor ? ' · ' + h.reportadoPor : '')));
      setFb('on', snap.metadata.fromCache ? 'Datos locales (sin conexión ahora); se sincroniza al volver la red.' : 'Proyecto ' + (cfg.config || FB_DEFAULT).projectId + '.');
    }, (e) => { console.warn(e); setFb('err', 'Firestore: ' + (e.code || e.message) + '. Revisa las reglas y que Authentication anónimo esté habilitado.'); });
  } catch (e) {
    console.warn(e);
    setFb('err', e.code === 'auth/operation-not-allowed' ? 'Habilita el acceso Anónimo en Authentication (Firebase).' : (e.message || String(e)));
  }
}
function desconectarFb() { if (S.fb && S.fb.unsub) S.fb.unsub(); S.fb = null; LS.del('fb'); setFb('local'); toast('Sincronización desactivada'); renderAjustes(); }

// ---- notificaciones
async function notificar(titulo, cuerpo) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(titulo, { body: cuerpo, icon: 'assets/icono-192.png', badge: 'assets/icono-192.png', tag: 'semaforo-' + Date.now() });
  } catch (e) { try { new Notification(titulo, { body: cuerpo, icon: 'assets/icono-192.png' }); } catch (e2) {} }
}
function avisarVencidos() { // una vez al día, al abrir la app
  const vencidos = activos().filter((h) => vencido(h) || sinAtender(h));
  if (!vencidos.length || LS.get('ultimoAvisoVencidos') === hoyISO()) return;
  LS.set('ultimoAvisoVencidos', hoyISO());
  notificar(`⏰ ${vencidos.length} hallazgo${vencidos.length > 1 ? 's' : ''} requiere${vencidos.length > 1 ? 'n' : ''} atención`, vencidos.slice(0, 3).map((h) => h.titulo).join(' · '));
}

// ---- datos de ejemplo
function imagenEjemplo(texto, color) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, 640, 480);
  x.fillStyle = 'rgba(255,255,255,.15)'; for (let i = 0; i < 640; i += 80) for (let j = 0; j < 480; j += 80) if ((i + j) % 160 === 0) x.fillRect(i, j, 80, 80);
  x.fillStyle = '#fff'; x.font = 'bold 34px sans-serif'; x.textAlign = 'center'; x.fillText('FOTO DE EJEMPLO', 320, 220); x.font = '26px sans-serif'; x.fillText(texto, 320, 270);
  return c;
}
async function cargarEjemplos() {
  if (!confirm('Se agregarán 4 hallazgos de ejemplo (con fotos simuladas). ¿Continuar?')) return;
  const dia = 86400000, ahora = Date.now(), yo = S.ajustes.usuario || 'Demo';
  const ejemplos = [
    { titulo: 'Porcelanato de piso soplado', categoria: 'Pisos', prioridad: 'alta', sector: 'Torre B', piso: '3', recinto: 'Pasillo frente a sala 312', descripcion: 'Tres palmetas sueltas, riesgo de caída de pacientes y camillas.', estado: 'rojo', hace: 5, color: '#8d6e63', plazo: -1 },
    { titulo: 'Filtración en cielo falso', categoria: 'Cielos', prioridad: 'alta', sector: 'Urgencia', piso: '1', recinto: 'Box 4', descripcion: 'Mancha de humedad y goteo intermitente.', estado: 'amarillo', hace: 3, inicio: 1, responsable: 'Empresa Mantenimientos SPA', color: '#546e7a' },
    { titulo: 'Puerta de baño no cierra', categoria: 'Puertas y ventanas', prioridad: 'media', sector: 'Torre A', piso: '2', recinto: 'Baño pacientes 205', descripcion: 'Bisagra superior suelta.', estado: 'rojo', hace: 1, color: '#6d4c41' },
    { titulo: 'Enchufe quemado', categoria: 'Eléctrico', prioridad: 'alta', sector: 'Torre A', piso: '4', recinto: 'Estación de enfermería', descripcion: 'Se reemplazó el módulo completo.', estado: 'verde', hace: 9, inicio: 8, fin: 7, responsable: 'Electricidad interna', color: '#ef6c00' },
  ];
  for (const e of ejemplos) {
    const creado = ahora - e.hace * dia;
    const img = imagenEjemplo(e.titulo, e.color);
    const foto = { id: nuevoId(), completa: img.toDataURL('image/jpeg', .7), mini: redimensionar(img, 320, .6), fecha: creado };
    const h = { id: nuevoId(), titulo: e.titulo, categoria: e.categoria, prioridad: e.prioridad, sector: e.sector, piso: e.piso, recinto: e.recinto, descripcion: e.descripcion,
      responsable: e.responsable || '', plazo: e.plazo != null ? new Date(ahora + e.plazo * dia).toISOString().slice(0, 10) : '', reportadoPor: yo, estado: e.estado, creadoEn: creado,
      inicioEn: e.inicio != null ? ahora - e.inicio * dia : null, finEn: e.fin != null ? ahora - e.fin * dia : null, fotos: [], historial: [], eliminado: false };
    const ids = await guardarFotosPendientes(h, [foto], 'rojo');
    h.historial.push({ fecha: creado, tipo: 'creado', estado: 'rojo', nota: 'Hallazgo reportado', por: yo, fotoIds: ids });
    if (h.inicioEn) h.historial.push({ fecha: h.inicioEn, tipo: 'estado', estado: 'amarillo', nota: 'Se inició la reparación', por: e.responsable, fotoIds: [] });
    if (h.finEn) h.historial.push({ fecha: h.finEn, tipo: 'estado', estado: 'verde', nota: 'Trabajo terminado y probado', por: e.responsable, fotoIds: [] });
    await guardarHallazgo(h);
  }
  toast('Ejemplos cargados'); irA('tablero');
}
async function borrarTodo() {
  if (!confirm('Se borrarán todos los hallazgos y fotos de ESTE dispositivo (no de la nube ni de otros equipos). ¿Continuar?')) return;
  if (S.fb && S.fb.unsub) { S.fb.unsub(); S.fb = null; } LS.del('fb');
  await DB.limpiar('hallazgos'); await DB.limpiar('fotos');
  S.hallazgos = {}; setFb('local'); render(); toast('Datos locales borrados'); irA('tablero');
}

// ------------------------------------------------------------ render general
function render() {
  $('#cabSubtitulo').textContent = S.ajustes.establecimiento || 'Hospital';
  renderTablero();
  if (S.vista === 'detalle') renderDetalle();
  if (S.vista === 'informes') renderInformes();
  if (S.vista === 'ajustes') renderAjustes();
}

// ------------------------------------------------------------ eventos
function conectarEventos() {
  $$('.menu button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.vista === 'nuevo') { $('#nId').value = ''; prepararFormulario(null); } irA(b.dataset.vista); }));
  // tablero
  $$('#semaforo .luz').forEach((b) => b.addEventListener('click', () => { S.filtro.estado = S.filtro.estado === b.dataset.estado ? '' : b.dataset.estado; renderTablero(); }));
  $('#fBuscar').addEventListener('input', (e) => { S.filtro.texto = e.target.value; renderTablero(); });
  $('#fSector').addEventListener('change', (e) => { S.filtro.sector = e.target.value; renderTablero(); });
  $('#fCategoria').addEventListener('change', (e) => { S.filtro.categoria = e.target.value; renderTablero(); });
  $('#fPrioridad').addEventListener('change', (e) => { S.filtro.prioridad = e.target.value; renderTablero(); });
  $('#fOrden').addEventListener('change', (e) => { S.filtro.orden = e.target.value; renderTablero(); });
  $('#fLimpiar').addEventListener('click', () => { S.filtro = { estado: '', texto: '', sector: '', categoria: '', prioridad: '', orden: S.filtro.orden }; $('#fBuscar').value = ''; $('#fPrioridad').value = ''; renderTablero(); });
  $('#lista').addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) abrirDetalle(it.dataset.id); });
  $('#alertas').addEventListener('click', (e) => { const a = e.target.closest('.alerta'); if (!a) return; S.filtro.estado = a.dataset.alerta === 'viejos' ? 'rojo' : ''; S.filtro.orden = a.dataset.alerta === 'vencidos' ? 'plazo' : 'antiguo'; $('#fOrden').value = S.filtro.orden; renderTablero(); });
  // nuevo
  $('#btnCamara').addEventListener('click', () => $('#nFotoCamara').click());
  $('#btnGaleria').addEventListener('click', () => $('#nFotoGaleria').click());
  $('#nFotoCamara').addEventListener('change', (e) => { agregarArchivos(e.target.files, S.fotosNuevo, $('#nPreview')); e.target.value = ''; });
  $('#nFotoGaleria').addEventListener('change', (e) => { agregarArchivos(e.target.files, S.fotosNuevo, $('#nPreview')); e.target.value = ''; });
  $('#formHallazgo').addEventListener('submit', enviarFormulario);
  $('#btnCancelarNuevo').addEventListener('click', () => { const id = $('#nId').value; $('#nId').value = ''; if (id) abrirDetalle(id); else irA('tablero'); });
  // detalle
  $('#btnVolver').addEventListener('click', () => irA('tablero'));
  $('#btnEditar').addEventListener('click', () => { const h = S.hallazgos[S.detalleId]; if (!h) return; prepararFormulario(h); irA('nuevo'); });
  $('#btnEliminar').addEventListener('click', eliminarHallazgo);
  $('#accCamara').addEventListener('click', () => $('#accFotoCamara').click());
  $('#accGaleria').addEventListener('click', () => $('#accFotoGaleria').click());
  $('#accFotoCamara').addEventListener('change', (e) => { agregarArchivos(e.target.files, S.fotosAccion, $('#accPreview')); e.target.value = ''; });
  $('#accFotoGaleria').addEventListener('change', (e) => { agregarArchivos(e.target.files, S.fotosAccion, $('#accPreview')); e.target.value = ''; });
  $('#formAccion').addEventListener('submit', confirmarAccion);
  $('#accCancelar').addEventListener('click', () => $('#dlgAccion').close());
  $('#visorCerrar').addEventListener('click', () => $('#dlgFoto').close());
  $('#visorImg').addEventListener('click', () => $('#dlgFoto').close());
  // informes
  $('#btnInformeDescargar').addEventListener('click', async () => entregarArchivo(nombreArchivo('Informe_hallazgos', 'html'), await generarInforme(), 'text/html', false));
  $('#btnInformeCompartir').addEventListener('click', async () => entregarArchivo(nombreArchivo('Informe_hallazgos', 'html'), await generarInforme(), 'text/html', true));
  $('#btnCsvDescargar').addEventListener('click', () => entregarArchivo(nombreArchivo('Hallazgos', 'csv'), generarCSV(), 'text/csv', false));
  $('#btnCsvCompartir').addEventListener('click', () => entregarArchivo(nombreArchivo('Hallazgos', 'csv'), generarCSV(), 'text/csv', true));
  $('#btnRespaldoDescargar').addEventListener('click', async () => entregarArchivo(nombreArchivo('Respaldo_semaforo', 'json'), await generarRespaldo(), 'application/json', false));
  $('#btnRespaldoCompartir').addEventListener('click', async () => entregarArchivo(nombreArchivo('Respaldo_semaforo', 'json'), await generarRespaldo(), 'application/json', true));
  $('#btnImportar').addEventListener('click', () => $('#archivoImportar').click());
  $('#archivoImportar').addEventListener('change', (e) => { if (e.target.files[0]) importarRespaldo(e.target.files[0]); e.target.value = ''; });
  // ajustes
  $('#ajUsuario').addEventListener('change', (e) => { S.ajustes.usuario = e.target.value.trim(); guardarAjustes(); });
  $('#ajEstablecimiento').addEventListener('change', (e) => { S.ajustes.establecimiento = e.target.value.trim() || 'Hospital'; guardarAjustes(); render(); });
  $('#ajDiasAlerta').addEventListener('change', (e) => { S.ajustes.diasAlerta = Math.max(1, +e.target.value || 3); guardarAjustes(); render(); });
  $('#btnConectar').addEventListener('click', () => {
    const clave = $('#ajClave').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (clave.length < 4) { toast('La clave debe tener al menos 4 caracteres'); return; }
    const txt = $('#ajFbConfig').value.trim(); const config = txt ? parseFbConfig(txt) : null;
    if (txt && !config) { toast('No se reconoce el bloque firebaseConfig (faltan apiKey, projectId o appId)'); return; }
    if (txt && S.fb && firebase.apps.length && firebase.app().options.projectId !== config.projectId) { toast('Para cambiar de proyecto, recarga la app después de guardar'); }
    $('#ajClave').value = clave;
    LS.set('fb', { clave, config, configTexto: txt });
    conectarFb();
  });
  $('#btnDesconectar').addEventListener('click', desconectarFb);
  $('#btnSync').addEventListener('click', () => irA('ajustes'));
  $('#btnNotif').addEventListener('click', async () => { if (!('Notification' in window)) return; await Notification.requestPermission(); renderAjustes(); if (Notification.permission === 'granted') notificar('Semáforo Mantención', 'Las notificaciones están activadas.'); });
  $('#btnDemo').addEventListener('click', cargarEjemplos);
  $('#btnBorrarTodo').addEventListener('click', borrarTodo);
}

// ------------------------------------------------------------ inicio
async function iniciar() {
  try { (await DB.todos('hallazgos')).forEach((h) => { S.hallazgos[h.id] = h; }); }
  catch (e) { console.error(e); toast('No se pudo abrir la base de datos local'); }
  conectarEventos();
  $('#nCategoria').innerHTML = CATEGORIAS.map((c) => `<option>${c}</option>`).join('');
  render();
  if (LS.get('fb')) conectarFb();
  avisarVencidos();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
iniciar();
