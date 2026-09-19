# Semáforo Mantención — guía de uso

App para celular (y PC) que registra hallazgos de mantención con foto y los sigue con un semáforo:

- 🔴 **Rojo — Reportado**: alguien vio el problema, le sacó foto y lo reportó. Nadie lo ha tomado.
- 🟡 **Amarillo — En trabajo**: alguien lo tomó y está reparando (queda registrado quién y desde cuándo).
- 🟢 **Verde — Finalizado**: la mejora u obra está terminada (idealmente con foto del resultado).

No depende de Claude ni de ningún servicio pagado. Funciona sin internet y, si se activa la sincronización, todo el equipo ve lo mismo.

## 1. Publicar la app (una vez, desde el PC)

1. Clic derecho sobre `publicar.ps1` → **Ejecutar con PowerShell**.
2. Al terminar muestra la dirección: `https://gconsacs-hash.github.io/semaforo-mantencion/`

Mientras no esté publicada, también se puede probar en el PC abriendo PowerShell en esta carpeta y escribiendo `npx http-server -p 8791` → http://localhost:8791/

## 2. Instalar en el celular (Android)

1. Abrir la dirección en **Chrome**.
2. Menú ⋮ → **Instalar app** (o "Agregar a pantalla principal").
3. Abrirla → **Ajustes** → escribir tu nombre y el nombre del establecimiento.

## 3. Conectar al equipo (para que todos vean lo mismo)

1. En el primer celular: **Ajustes → Sincronización con el equipo** → elegir una **clave de equipo** (ej. `hospital-mantencion-2026`) → **Conectar**. El punto de arriba a la derecha queda verde.
2. En los demás celulares y en el PC: misma dirección, **misma clave**, **Conectar**.

Los datos se guardan en tu proyecto Firebase `rumbo-3ba8c` (el mismo de la app Rumbo, plan gratuito; usa una carpeta distinta, no se mezclan). Quien tenga la clave ve los hallazgos: compártela solo con el equipo.

Si prefieres un proyecto Firebase aparte: crear proyecto en https://console.firebase.google.com → Authentication → habilitar **Anónimo** → Firestore Database → crear (modo producción) → Reglas:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /spaces/{space}/docs/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Luego Configuración del proyecto → "Tus apps" → app web → copiar el bloque `firebaseConfig` y pegarlo en **Ajustes → Usar otro proyecto Firebase**.

## 4. Uso diario

- **➕ Nuevo**: tomar foto (o varias), escribir qué se encontró, dónde (sector / piso / recinto), prioridad, plazo y responsable → **Reportar en rojo**.
- **Tablero**: las tres luces muestran cuántos hay en cada estado; tocar una luz filtra. Arriba aparecen alertas de hallazgos con plazo vencido o que llevan más de X días en rojo (X se ajusta en Ajustes).
- **Abrir un hallazgo**: botones para **Iniciar trabajo** (→ amarillo, pide quién lo ejecuta), **Marcar finalizado** (→ verde, se recomienda foto del trabajo terminado), **Volver a pendiente** o **Reabrir**. Cada cambio queda en el historial con fecha, persona, comentario y fotos.
- **Agregar nota / foto**: registra avances sin cambiar el estado.
- **Compartir**: envía el hallazgo con su foto por WhatsApp, correo, etc.
- **Notificaciones** (Ajustes): avisa cuando llega un hallazgo nuevo en rojo desde otro celular y, al abrir la app, si hay vencidos.

## 5. Informes y guardar en Drive

En **Informes**:

- **Informe con fotos** (archivo HTML): se abre en cualquier celular o PC; desde Chrome se puede **Imprimir → Guardar como PDF**.
- **Planilla Excel (CSV)**: todos los hallazgos con fechas, estado, responsable, días abiertos.
- **Respaldo completo (JSON)**: fichas + historial + fotos; se restaura con "Restaurar desde un respaldo".

Cada uno tiene dos botones:

- **Descargar**: queda en la carpeta Descargas.
- **Compartir / guardar en Drive**: abre el menú de compartir de Android, donde aparecen **Google Drive**, OneDrive, WhatsApp, Gmail, etc.

## 6. Actualizar la app

Los archivos viven en `OneDrive\Escritorio\claude\SemaforoMantencion`. Tras cambiar algo, subir el número de `VERSION` en `sw.js` (`semaforo-v1` → `semaforo-v2`…) y ejecutar `publicar.ps1` de nuevo. Los celulares reciben la versión nueva al abrir la app con internet.

## 7. Costos y límites

- GitHub Pages: gratis. Firebase plan Spark: gratis (1 GB de almacenamiento ≈ 4.000–8.000 fotos; 50.000 lecturas / 20.000 escrituras al día). No pide tarjeta.
- Las fotos se reducen automáticamente (máx. 1280 px) para que pesen 100–300 KB cada una.
- El `apiKey` de Firebase que va dentro de la app es un identificador público, no un secreto; la protección real son las reglas de Firestore y la clave de equipo.
