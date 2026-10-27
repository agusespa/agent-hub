// Keep the browser layout unchanged; only macOS desktop windows overlay native controls.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('integrated-titlebar');
  });
}
