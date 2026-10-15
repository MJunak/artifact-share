const pageUrl = document.currentScript.dataset.url;
const button = document.getElementById('copy');
button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pageUrl);
    button.textContent = 'Kopiert ✓';
  } catch {
    prompt('Link:', pageUrl);
  }
  setTimeout(() => (button.textContent = 'Link kopieren'), 1600);
});
