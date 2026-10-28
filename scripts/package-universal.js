const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const ignore = [
  /^\/stt($|\/)/,
  /^\/native\/PasteHelper\.cs$/,
  /^\/screenshots($|\/)/,
  /^\/dist($|\/)/,
  /^\/release($|\/)/,
  /^\/installer($|\/)/,
  /^\/docs($|\/)/,
  /^\/scripts($|\/)/,
  /^\/\.github($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.gitignore$/,
  /^\/\.gitattributes$/,
  /^\/assets\/make_icon\.py$/,
  /__pycache__/,
  /^\/contexte($|\/)/,
  /^\/\.claude($|\/)/,
  /^\/assets\/.*\.icns$/,
  /^\/README\.md$/,
  /^\/CHANGELOG\.md$/
];

const extraResource = [];
for (const folder of ['stt/dist/freeflow-stt-cuda', 'stt/dist/freeflow-stt-rocm', 'stt/dist/freeflow-stt']) {
  if (fs.existsSync(folder)) extraResource.push(folder);
}
if (fs.existsSync('native/PasteHelper.exe')) extraResource.push('native/PasteHelper.exe');

(async () => {
  try {
    const appPaths = await packager({
      dir: '.',
      name: 'FreeFlow',
      platform: 'win32',
      arch: 'x64',
      overwrite: true,
      icon: 'assets/icon.ico',
      out: 'release',
      extraResource,
      ignore
    });
    console.log('Packaged:', appPaths);
    console.log('Engines included:', extraResource.filter((p) => /freeflow-stt/.test(p)));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();