// Run in the library window by `Pape.exe --smoke` (see RunSmokeAsync in Engine.cs).
// Visits every tab, then clicks the image wallpaper so it gets applied. Throwing fails the check.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !document.querySelector('.card'); i++) await sleep(100);
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) throw new Error('no wallpaper cards');
  for (const t of ['displays', 'playlists', 'settings', 'wallpapers']) {
    document.querySelector(`[data-tab="${t}"]`).click();
    await sleep(200);
    if (!document.querySelector(`#tab-${t}.on`)) throw new Error('tab did not open: ' + t);
  }
  const image = cards.find(c => c.dataset.type === 'image');
  if (!image) throw new Error('no image card');
  image.click();
  await sleep(400);
  if (!document.querySelector('#panel .props')) throw new Error('properties panel missing');
  return JSON.stringify({ cards: cards.length, errors: window.__errors || [] });
})()
