// POST /__reset on the practice desktop (desktop token).
const r = await fetch(`${process.env.DESKTOP_HTTP}/__reset`, { method: "POST", headers: { Authorization: `Bearer ${process.env.DESKTOP_TOKEN}` } });
console.log(`__reset → HTTP ${r.status}`, (await r.text()).slice(0, 300));
