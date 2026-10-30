// Applies a saved appearance choice before first paint. No saved choice means the system setting.
try { var t = localStorage.getItem("mymail-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }
