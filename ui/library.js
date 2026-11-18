// Store a copy of each normalized image in the desktop WebView's user profile.
// A single read/write transaction also deduplicates imports from two open windows.
let database;
function openLibrary() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("paperseal-images", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("images", { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { database = undefined; throw error; });
  }
  return database;
}

async function transaction(mode, action) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("images", mode);
    const result = action(tx.objectStore("images"));
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error || new Error("图片库写入中断"));
  });
}

export const listImages = () => transaction("readonly", store => store.getAll());
export const forgetImage = id => transaction("readwrite", store => store.delete(id));
export function rememberImage(group, image) {
  return transaction("readwrite", store => {
    const lookup = store.getAll();
    lookup.onsuccess = () => {
      const existing = lookup.result.find(item => item.group === group && item.url === image.url);
      store.put({ ...existing, ...image, group, used: Date.now() });
    };
  });
}
