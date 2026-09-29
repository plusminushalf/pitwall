// Preloaded (`bun --preload`) into the child processes of the dev server's race downloader
// (devserver/ingestPlugin.ts). The plugin kills its children when the server closes, but if the server dies
// without closing (SIGKILL, crash) the child is re-parented: exit rather than keep downloading unattended.
// Completed cache files stay, so the next run resumes from them.

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(1);
}, 1000).unref();
