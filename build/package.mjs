import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageRoot = path.join(root, 'dist-stage');
const stageApp = path.join(stageRoot, 'app');
const outDir = path.join(root, 'dist');
const electronVersion = '45.2.3';

const runtimeFiles = [
  'main.js',
  'preload.js',
  'records-store.js',
  'holiday-api.js',
  'holiday-store.js',
];

const rendererFiles = [
  'index.html',
  'style.css',
  'renderer.js',
  'settings.html',
  'settings.css',
  'settings.js',
  'leave.html',
  'leave.css',
  'leave.js',
  'report.html',
  'report.css',
  'report.js',
];

const assetFiles = ['icon.png', 'icon.ico', 'tray.png'];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 1. 准备干净的打包目录（只包含运行时文件）
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(stageApp, 'renderer'), { recursive: true });
fs.mkdirSync(path.join(stageApp, 'assets'), { recursive: true });

for (const name of runtimeFiles) {
  copy(path.join(root, name), path.join(stageApp, name));
}
for (const name of rendererFiles) {
  copy(path.join(root, 'renderer', name), path.join(stageApp, 'renderer', name));
}
for (const name of assetFiles) {
  copy(path.join(root, 'assets', name), path.join(stageApp, 'assets', name));
}

const appPackage = {
  name: 'salary-widget',
  productName: '工资小组件',
  version: '1.0.0',
  description: 'Windows 桌面工资小组件：实时收入、下班倒计时与月度薪资统计',
  main: 'main.js',
  author: 'Salary Widget contributors',
  license: 'MIT',
};
fs.writeFileSync(path.join(stageApp, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`, 'utf8');

// 2. 如果本地已有 Electron 压缩包就复用，否则让 packager 自动下载
const zipsDir = path.join(root, '.electron-zips');
const targetZip = path.join(zipsDir, `electron-v${electronVersion}-win32-x64.zip`);
const packagerOptions = {
  dir: stageApp,
  name: 'SalaryWidget',
  platform: 'win32',
  arch: 'x64',
  out: outDir,
  overwrite: true,
  icon: path.join(root, 'assets', 'icon.ico'),
  electronVersion,
  appVersion: '1.0.0',
  buildVersion: '1.0.0',
  asar: false,
  prune: true,
  win32metadata: {
    CompanyName: 'Salary Widget',
    FileDescription: '工资小组件',
    ProductName: '工资小组件',
    InternalName: 'SalaryWidget',
    OriginalFilename: '工资小组件.exe',
    LegalCopyright: 'Copyright © 2026 Salary Widget contributors',
  },
};
if (fs.existsSync(targetZip)) {
  packagerOptions.electronZipDir = zipsDir;
}

// 3. 打包
const appPaths = await packager(packagerOptions);
console.log('packager output:', appPaths);

// 4. 改成中文目录名和 exe 名
const srcDir = appPaths[0];
const dstDir = path.join(outDir, '工资小组件');
fs.rmSync(dstDir, { recursive: true, force: true });
fs.renameSync(srcDir, dstDir);

const oldExe = path.join(dstDir, 'SalaryWidget.exe');
const newExe = path.join(dstDir, '工资小组件.exe');
if (fs.existsSync(oldExe)) fs.renameSync(oldExe, newExe);

console.log('done:', dstDir);
