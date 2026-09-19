/* Base de datos local del teléfono (IndexedDB).
   Guarda los hallazgos y las fotos aunque no haya internet.
   Dos "cajones": 'hallazgos' (fichas) y 'fotos' (imágenes en tamaño completo). */

const DB = (() => {
  const NOMBRE = "semaforo-mantencion";
  const VERSION = 1;
  let db = null;

  function abrir() {
    return new Promise((resolver, rechazar) => {
      if (db) return resolver(db);
      const pedido = indexedDB.open(NOMBRE, VERSION);
      pedido.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains("hallazgos")) d.createObjectStore("hallazgos", { keyPath: "id" });
        if (!d.objectStoreNames.contains("fotos")) d.createObjectStore("fotos", { keyPath: "id" });
      };
      pedido.onsuccess = (e) => { db = e.target.result; resolver(db); };
      pedido.onerror = () => rechazar(pedido.error);
    });
  }

  async function transaccion(cajon, modo, accion) {
    const d = await abrir();
    return new Promise((resolver, rechazar) => {
      const t = d.transaction(cajon, modo);
      const pedido = accion(t.objectStore(cajon));
      t.oncomplete = () => resolver(pedido && pedido.result);
      t.onerror = () => rechazar(t.error);
      t.onabort = () => rechazar(t.error);
    });
  }

  return {
    todos:   (cajon)      => transaccion(cajon, "readonly",  (s) => s.getAll()),
    claves:  (cajon)      => transaccion(cajon, "readonly",  (s) => s.getAllKeys()),
    obtener: (cajon, id)  => transaccion(cajon, "readonly",  (s) => s.get(id)),
    guardar: (cajon, obj) => transaccion(cajon, "readwrite", (s) => s.put(obj)),
    borrar:  (cajon, id)  => transaccion(cajon, "readwrite", (s) => s.delete(id)),
    limpiar: (cajon)      => transaccion(cajon, "readwrite", (s) => s.clear()),
  };
})();
