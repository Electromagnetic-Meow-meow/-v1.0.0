const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  dialog,
  globalShortcut,
  shell,
  safeStorage,
} = require('electron');
const { createHolidayStore } = require('./holiday-store');
const { createRecordsStore } = require('./records-store');
const { fetchYear: fetchHolidayYear } = require('./holiday-api');

// ---------------------------------------------------------------------------
// 数据目录
// 优先使用 exe 旁边的 userdata（保证从不同启动方式打开时配置一致）；
// 如果程序目录只读，再退回 %APPDATA%\salary-widget。
// ---------------------------------------------------------------------------
function pickWritableDir(candidates) {
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

let appDataWritable = null;
let dataDir;
if (process.env.SALARY_WIDGET_DATA) {
  dataDir = path.resolve(process.env.SALARY_WIDGET_DATA);
} else {
  const appDataDir = process.env.APPDATA || app.getPath('appData');
  const localAppDataDir = process.env.LOCALAPPDATA || '';
  const portableDir = path.join(path.dirname(process.execPath), 'userdata');
  if (appDataDir) {
    appDataWritable = Boolean(pickWritableDir([path.join(appDataDir, 'salary-widget')]));
  }
  const candidates = [portableDir];
  if (appDataDir) candidates.push(path.join(appDataDir, 'salary-widget'));
  if (localAppDataDir) candidates.push(path.join(localAppDataDir, 'salary-widget'));
  dataDir = pickWritableDir(candidates) || candidates[0];
}
app.setPath('userData', dataDir);
log('appDataWritable=', appDataWritable, 'session=', process.env.SESSIONNAME, 'user=', process.env.USERNAME, 'ppid=', process.ppid);

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}\n`;
  try {
    const file = path.join(app.getPath('userData'), 'main.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    // 日志失败不影响主流程
  }
  try {
    // 额外写一份到临时目录，便于排查“窗口没出现”的环境问题
    const tempFile = path.join(os.tmpdir(), 'salary-widget-boot.log');
    fs.appendFileSync(tempFile, line, 'utf8');
  } catch {
    // ignore
  }
}

async function captureWindow(win, name) {
  if (!win || win.isDestroyed()) return;
  try {
    const image = await win.webContents.capturePage();
    const file = path.join(app.getPath('userData'), name);
    fs.writeFileSync(file, image.toPNG());
    log('captured', name, JSON.stringify(image.getSize()));
  } catch (err) {
    log('capture failed', name, err.message);
  }
}

process.on('uncaughtException', (err) => log('uncaughtException', err.stack || err.message));
process.on('unhandledRejection', (err) => log('unhandledRejection', String(err)));

// 部分虚拟机、远程桌面或安全软件环境里，Chromium 沙箱会导致进程启动后
// 立刻退出（exe 双击无反应）。本应用只加载本地文件，关闭沙箱以保证可用。
app.commandLine.appendSwitch('no-sandbox');

// 桌面小组件只需要 2D 绘制。关闭硬件加速可以避免部分虚拟机/远程桌面/
// 老旧显卡上透明窗口无法创建或启动即崩溃的问题。
app.disableHardwareAcceleration();
log('main process started, version=', app.getVersion());

if (process.platform === 'win32') {
  app.setAppUserModelId('com.salarywidget.desktop');
}

const WIDGET_WIDTH = 356;
const WIDGET_HEIGHT = 240;
const WIDGET_MIN_WIDTH = 220;
const WIDGET_MIN_HEIGHT = 145;
const DOCK_SNAP_PX = 16;
const DOCK_UNDOCK_PX = 24;
const WIDGET_MAX_WIDTH = 900;
const WIDGET_MAX_HEIGHT = 700;
const SETTINGS_WIDTH = 452;
const ACCENTS = ['sunset', 'gold', 'coral', 'pink', 'violet', 'blue', 'cyan', 'mint'];
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

const DEFAULT_CONFIG = {
  monthlySalary: 15000,
  workDaysPerMonth: 21.75,
  workStart: '09:00',
  workEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  eveningStart: '18:00',
  eveningEnd: '18:00',
  overtimeBase: 15000,
  overtimeMultiplier: 1.5,
  weekendOvertimeMultiplier: 2,
  holidayOvertimeMultiplier: 3,
  sickLeaveRatio: 0.8,
  countOvertime: true,
  weekendOff: true,
  workdays: [1, 2, 3, 4, 5],
  autoWorkdayOt: false,
  autoRestOt: false,
  holidayApiEnabled: false,
  holidayApiKey: '',
  holidayApiKeyEnc: '',
  holidayApiKeySet: false,
  alwaysOnTop: true,
  minimizeToTray: false,
  dockEnabled: true,
  dockDocked: false,
  dockEdge: 'bottom',
  dockOffset: 0.5,
  accent: 'sunset',
  windowBounds: null,
};

let config = { ...DEFAULT_CONFIG };
let widget = null;
let settingsWin = null;
let leaveWin = null;
let reportWin = null;
let widgetDocked = false;
let widgetDockCollapsed = false;
let widgetDockNormalBounds = null;
let widgetDockSuppressMoveUntil = 0;
let widgetDockMoveTimer = null;
let widgetDockHoverLeaveAt = 0;
let widgetDockUserMoving = false;
let widgetDockMoveIdleTimer = null;
let widgetDockLastBounds = null;
let widgetDockBoundsChangedAt = 0;
let widgetDockPendingCheck = false;
let widgetDockMenuOpen = false;
let holidayStore = null;
let recordsStore = null;
let holidayApiCache = null;
let holidayApiLastError = '';
let holidayApiSyncing = false;
const HOLIDAY_API_DAILY_LIMIT = 3;
const HOLIDAY_API_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
let holidayApiUsage = { date: '', auto: 0, manual: 0 };
let tray = null;
let trayUsable = false;
let hotkeyRegistered = false;
let existingInstanceShown = false;
let isQuitting = false;
let saveBoundsTimer = null;
let firstRun = false;
let trayHintShown = false;

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function timeOkay(value, fallback) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : fallback;
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.min(WIDGET_MAX_WIDTH, Math.max(WIDGET_MIN_WIDTH, Math.round(width))),
    height: Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.round(height))),
  };
}

function sanitizeWorkdays(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice();
  const days = [...new Set(
    value
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  )].sort((a, b) => a - b);
  return days.length ? days : fallback.slice();
}

function sanitizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_CONFIG, ...src };
  const defaultWorkdays = merged.weekendOff === false
    ? [0, 1, 2, 3, 4, 5, 6]
    : DEFAULT_CONFIG.workdays;
  const safe = {
    monthlySalary: clampNumber(merged.monthlySalary, 0, 10000000, DEFAULT_CONFIG.monthlySalary),
    workDaysPerMonth: clampNumber(merged.workDaysPerMonth, 1, 31, DEFAULT_CONFIG.workDaysPerMonth),
    workStart: timeOkay(merged.workStart, DEFAULT_CONFIG.workStart),
    workEnd: timeOkay(merged.workEnd, DEFAULT_CONFIG.workEnd),
    lunchStart: timeOkay(merged.lunchStart, DEFAULT_CONFIG.lunchStart),
    lunchEnd: timeOkay(merged.lunchEnd, DEFAULT_CONFIG.lunchEnd),
    eveningStart: timeOkay(merged.eveningStart, DEFAULT_CONFIG.eveningStart),
    eveningEnd: timeOkay(merged.eveningEnd, DEFAULT_CONFIG.eveningEnd),
    overtimeBase: clampNumber(merged.overtimeBase, 0, 10000000, DEFAULT_CONFIG.overtimeBase),
    overtimeMultiplier: clampNumber(merged.overtimeMultiplier, 0, 10, DEFAULT_CONFIG.overtimeMultiplier),
    weekendOvertimeMultiplier: clampNumber(merged.weekendOvertimeMultiplier, 0, 10, DEFAULT_CONFIG.weekendOvertimeMultiplier),
    holidayOvertimeMultiplier: clampNumber(merged.holidayOvertimeMultiplier, 0, 10, DEFAULT_CONFIG.holidayOvertimeMultiplier),
    sickLeaveRatio: clampNumber(merged.sickLeaveRatio, 0, 1, DEFAULT_CONFIG.sickLeaveRatio),
    countOvertime: Boolean(merged.countOvertime),
    weekendOff: Boolean(merged.weekendOff),
    workdays: sanitizeWorkdays(merged.workdays, defaultWorkdays),
    autoWorkdayOt: Boolean(merged.autoWorkdayOt),
    autoRestOt: Boolean(merged.autoRestOt),
    holidayApiEnabled: Boolean(merged.holidayApiEnabled),
    holidayApiKeyEnc: typeof merged.holidayApiKeyEnc === 'string'
      ? merged.holidayApiKeyEnc.trim().slice(0, 4096)
      : '',
    alwaysOnTop: Boolean(merged.alwaysOnTop),
    minimizeToTray: Boolean(merged.minimizeToTray),
    dockEnabled: merged.dockEnabled !== false,
    dockDocked: Boolean(merged.dockDocked),
    dockEdge: ['top', 'bottom', 'left', 'right'].includes(merged.dockEdge) ? merged.dockEdge : 'bottom',
    dockOffset: clampNumber(merged.dockOffset, 0, 1, 0.5),
    accent: ACCENTS.includes(merged.accent) ? merged.accent : DEFAULT_CONFIG.accent,
    windowBounds: sanitizeBounds(merged.windowBounds),
  };
  if (safe.workStart >= safe.workEnd) {
    safe.workStart = DEFAULT_CONFIG.workStart;
    safe.workEnd = DEFAULT_CONFIG.workEnd;
  }
  return safe;
}

function encryptHolidayApiKey(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统安全存储不可用，无法加密保存 API Key');
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decryptHolidayApiKey(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统安全存储不可用，无法读取 API Key');
  }
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

function publicConfig() {
  return {
    ...config,
    holidayApiKey: '',
    holidayApiKeyEnc: '',
    holidayApiKeySet: Boolean(config.holidayApiKey),
  };
}

function loadConfig() {
  try {
    const file = configFile();
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const safe = sanitizeConfig(raw);
      safe.holidayApiKey = '';
      let migrated = false;

      // 兼容旧版本明文 Key：读取后立即用系统安全存储加密并回写。
      if (!safe.holidayApiKeyEnc && typeof raw.holidayApiKey === 'string' && raw.holidayApiKey.trim()) {
        try {
          const plain = raw.holidayApiKey.trim();
          safe.holidayApiKeyEnc = encryptHolidayApiKey(plain);
          safe.holidayApiKey = plain;
          migrated = true;
        } catch (err) {
          log('holiday api key migrate failed', err.message);
        }
      } else if (safe.holidayApiKeyEnc) {
        try {
          safe.holidayApiKey = decryptHolidayApiKey(safe.holidayApiKeyEnc);
        } catch (err) {
          log('holiday api key decrypt failed', err.message);
        }
      }

      config = safe;
      if (migrated) writeConfig();
      firstRun = false;
    } else {
      config = { ...DEFAULT_CONFIG };
      firstRun = true;
    }
  } catch (err) {
    log('load config failed', err.message);
    config = { ...DEFAULT_CONFIG };
    firstRun = true;
  }
}

function writeConfig() {
  try {
    const file = configFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const stored = { ...config };
    // 明文 Key 和派生状态不落盘，只保存 safeStorage 加密后的密文。
    delete stored.holidayApiKey;
    delete stored.holidayApiKeySet;
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    log('save config failed', err.message);
  }
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function emptyHolidayPayload() {
  return {
    holidays: {},
    workdays: [],
    statutory: [],
    years: [],
    sources: [],
    importedAt: 0,
  };
}

function holidayApiCacheFile() {
  return path.join(app.getPath('userData'), 'holidays-api-cache.json');
}

function loadHolidayApiCache() {
  try {
    const file = holidayApiCacheFile();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (
      raw &&
      Number.isInteger(raw.year) &&
      raw.data &&
      typeof raw.data.holidays === 'object'
    ) {
      holidayApiCache = {
        year: raw.year,
        fetchedAt: Number(raw.fetchedAt) || 0,
        data: {
          holidays: raw.data.holidays,
          workdays: Array.isArray(raw.data.workdays) ? raw.data.workdays : [],
          statutory: Array.isArray(raw.data.statutory) ? raw.data.statutory : [],
        },
      };
    }
  } catch (err) {
    log('holiday api cache load failed', err.message);
  }
}

function saveHolidayApiCache() {
  try {
    if (!holidayApiCache) return;
    const file = holidayApiCacheFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(holidayApiCache, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    log('holiday api cache save failed', err.message);
  }
}

function localDateKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function holidayApiUsageFile() {
  return path.join(app.getPath('userData'), 'holidays-api-usage.json');
}

function loadHolidayApiUsage() {
  const today = localDateKey();
  try {
    const file = holidayApiUsageFile();
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (raw && raw.date === today) {
        holidayApiUsage = {
          date: today,
          auto: Math.max(0, Math.min(HOLIDAY_API_DAILY_LIMIT, Number(raw.auto) || 0)),
          manual: Math.max(0, Math.min(HOLIDAY_API_DAILY_LIMIT, Number(raw.manual) || 0)),
        };
        return;
      }
    }
  } catch (err) {
    log('holiday api usage load failed', err.message);
  }
  holidayApiUsage = { date: today, auto: 0, manual: 0 };
  saveHolidayApiUsage();
}

function saveHolidayApiUsage() {
  try {
    const file = holidayApiUsageFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(holidayApiUsage, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    log('holiday api usage save failed', err.message);
  }
}

function ensureHolidayApiUsage() {
  const today = localDateKey();
  if (holidayApiUsage.date !== today) {
    holidayApiUsage = { date: today, auto: 0, manual: 0 };
    saveHolidayApiUsage();
  }
}

function holidayApiUsageStatus() {
  ensureHolidayApiUsage();
  return {
    date: holidayApiUsage.date,
    auto: holidayApiUsage.auto,
    manual: holidayApiUsage.manual,
    limit: HOLIDAY_API_DAILY_LIMIT,
  };
}

function holidayApiCacheState() {
  const data = holidayApiCache && holidayApiCache.data;
  const holidays = data ? Object.keys(data.holidays || {}).length : 0;
  const workdays = data ? (data.workdays || []).length : 0;
  const currentYear = new Date().getFullYear();
  const fetchedAt = holidayApiCache ? Number(holidayApiCache.fetchedAt) || 0 : 0;
  const expiresAt = fetchedAt ? fetchedAt + HOLIDAY_API_CACHE_TTL_MS : 0;
  const valid = Boolean(
    holidayApiCache
    && holidayApiCache.year === currentYear
    && (holidays > 0 || workdays > 0)
    && expiresAt > Date.now(),
  );
  return { valid, expiresAt, ttlMs: HOLIDAY_API_CACHE_TTL_MS, holidays, workdays };
}

function mergeUnique(...lists) {
  const result = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!result.includes(item)) result.push(item);
    }
  }
  return result.sort();
}

function mergedHolidayPayload() {
  const manual = holidayStore ? holidayStore.payload() : emptyHolidayPayload();
  if (!config.holidayApiEnabled || !holidayApiCache || !holidayApiCache.data) {
    return manual;
  }
  const api = holidayApiCache.data;
  const years = mergeUnique(manual.years, [String(holidayApiCache.year)]);
  return {
    years,
    holidays: { ...manual.holidays, ...api.holidays },
    workdays: mergeUnique(manual.workdays, api.workdays),
    statutory: mergeUnique(manual.statutory, api.statutory),
    sources: mergeUnique(manual.sources, [`天聚数行 ${holidayApiCache.year}`]),
    importedAt: Math.max(manual.importedAt || 0, holidayApiCache.fetchedAt || 0),
  };
}

function holidayStatus() {
  const payload = mergedHolidayPayload();
  return {
    years: payload.years,
    holidays: Object.keys(payload.holidays || {}).length,
    workdays: (payload.workdays || []).length,
    statutory: (payload.statutory || []).length,
    sources: payload.sources,
    importedAt: payload.importedAt,
    api: holidayApiStatus(),
  };
}

function holidayApiStatus() {
  const data = holidayApiCache && holidayApiCache.data;
  const cacheState = holidayApiCacheState();
  return {
    enabled: Boolean(config.holidayApiEnabled),
    keySet: Boolean(config.holidayApiKey),
    syncing: holidayApiSyncing,
    year: holidayApiCache ? holidayApiCache.year : null,
    fetchedAt: holidayApiCache ? holidayApiCache.fetchedAt : 0,
    holidays: data ? Object.keys(data.holidays || {}).length : 0,
    workdays: data ? (data.workdays || []).length : 0,
    statutory: data ? (data.statutory || []).length : 0,
    error: holidayApiLastError,
    usage: holidayApiUsageStatus(),
    cacheValid: cacheState.valid,
    cacheExpiresAt: cacheState.expiresAt,
    cacheTtlMs: cacheState.ttlMs,
  };
}

async function syncHolidayApi(force = false, source = 'auto') {
  const kind = source === 'manual' ? 'manual' : 'auto';
  if (!config.holidayApiEnabled) {
    return { ok: false, error: '在线节假日接口未启用', status: holidayApiStatus() };
  }
  if (!config.holidayApiKey) {
    return { ok: false, error: '请先填写天聚数行 API Key', status: holidayApiStatus() };
  }
  if (holidayApiSyncing) {
    return { ok: false, error: '正在同步，请稍候', status: holidayApiStatus() };
  }

  const cacheState = holidayApiCacheState();
  if (!force && cacheState.valid) {
    return { ok: true, cached: true, status: holidayApiStatus() };
  }

  const year = new Date().getFullYear();

  const usage = holidayApiUsageStatus();
  if (usage[kind] >= HOLIDAY_API_DAILY_LIMIT) {
    return {
      ok: false,
      error: `今日${kind === 'manual' ? '手动' : '自动'}同步次数已用完（${HOLIDAY_API_DAILY_LIMIT}/${HOLIDAY_API_DAILY_LIMIT}）`,
      status: holidayApiStatus(),
    };
  }

  holidayApiSyncing = true;
  holidayApiLastError = '';
  try {
    const data = await fetchHolidayYear(config.holidayApiKey, year);
    holidayApiCache = {
      year,
      fetchedAt: Date.now(),
      data,
    };
    saveHolidayApiCache();
    // 只有接口成功返回并解析成功才计数，失败不占用次数。
    const current = holidayApiUsageStatus();
    holidayApiUsage = {
      date: current.date,
      auto: current.auto,
      manual: current.manual,
      [kind]: current[kind] + 1,
    };
    saveHolidayApiUsage();
    holidayApiSyncing = false;
    broadcast('holidays:changed', mergedHolidayPayload());
    broadcast('holidays:api-changed', holidayApiStatus());
    log('holiday api synced', kind, year, 'holidays=', Object.keys(data.holidays).length);
    return { ok: true, status: holidayApiStatus() };
  } catch (err) {
    holidayApiLastError = err.message;
    holidayApiSyncing = false;
    log('holiday api failed', kind, err.message);
    return { ok: false, error: err.message, status: holidayApiStatus() };
  } finally {
    holidayApiSyncing = false;
  }
}

function applyAlwaysOnTop() {
  if (widget && !widget.isDestroyed()) {
    const keepOnTop = widgetDocked || widgetDockCollapsed;
    widget.setAlwaysOnTop(
      keepOnTop ? true : Boolean(config.alwaysOnTop),
      keepOnTop ? 'floating' : 'screen-saver',
    );
  }
}

function rememberCurrentNormalBounds() {
  if (!widget || widget.isDestroyed() || widgetDocked || widgetDockCollapsed) return;
  const b = widget.getBounds();
  const width = Math.max(WIDGET_MIN_WIDTH, Math.round(b.width));
  const height = Math.max(WIDGET_MIN_HEIGHT, Math.round(b.height));
  widgetDockNormalBounds = { x: b.x, y: b.y, width, height };
  config.windowBounds = { x: b.x, y: b.y, width, height };
}

function saveBounds() {
  if (!widget || widget.isDestroyed()) return;
  if (widgetDocked || widgetDockCollapsed) return;
  rememberCurrentNormalBounds();
  writeConfig();
}

function scheduleSaveBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveBounds, 400);
}

function rememberNormalSize(width, height) {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const w = Math.max(WIDGET_MIN_WIDTH, Math.round(Number(width) || b.width));
  const h = Math.max(WIDGET_MIN_HEIGHT, Math.round(Number(height) || b.height));
  widgetDockNormalBounds = { x: b.x, y: b.y, width: w, height: h };
  config.windowBounds = { x: b.x, y: b.y, width: w, height: h };
}

function widgetDockNormalSize() {
  const normal = widgetDockNormalBounds || config.windowBounds || {};
  return {
    width: Math.max(WIDGET_MIN_WIDTH, Math.round(Number(normal.width) || WIDGET_WIDTH)),
    height: Math.max(WIDGET_MIN_HEIGHT, Math.round(Number(normal.height) || WIDGET_HEIGHT)),
  };
}

function widgetDockSize(expanded) {
  const edge = config.dockEdge;
  const vertical = edge === 'left' || edge === 'right';
  if (expanded) {
    const normal = widgetDockNormalSize();
    return { width: normal.width, height: normal.height };
  }
  if (vertical) return { width: 32, height: 280 };
  return { width: 280, height: 39 };
}

function widgetDockArea() {
  return screen.getDisplayMatching(widget.getBounds()).workArea;
}

function widgetDockBounds(expanded) {
  const area = widgetDockArea();
  const size = widgetDockSize(expanded);
  const edge = config.dockEdge;
  const ratio = Math.min(1, Math.max(0, Number(config.dockOffset) || 0));
  let x = area.x;
  let y = area.y;
  if (edge === 'bottom') {
    x = area.x + area.width * ratio - size.width / 2;
    y = area.y + area.height - size.height;
  } else if (edge === 'top') {
    x = area.x + area.width * ratio - size.width / 2;
    y = area.y;
  } else if (edge === 'left') {
    x = area.x;
    y = area.y + area.height * ratio - size.height / 2;
  } else {
    x = area.x + area.width - size.width;
    y = area.y + area.height * ratio - size.height / 2;
  }
  x = Math.round(Math.min(area.x + area.width - size.width, Math.max(area.x, x)));
  y = Math.round(Math.min(area.y + area.height - size.height, Math.max(area.y, y)));
  return { x, y, width: size.width, height: size.height };
}

function alignWidgetDock() {
  if (!widget || widget.isDestroyed()) return;
  try {
    const content = widget.getContentBounds();
    const area = widgetDockArea();
    let x = content.x;
    let y = content.y;
    if (config.dockEdge === 'bottom') y = area.y + area.height - content.height;
    else if (config.dockEdge === 'top') y = area.y;
    else if (config.dockEdge === 'left') x = area.x;
    else x = area.x + area.width - content.width;
    widget.setPosition(Math.round(x), Math.round(y));
  } catch {
    // ignore
  }
}

function applyWidgetDockShape() {
  if (!widget || widget.isDestroyed()) return;
  try {
    if (!widgetDockCollapsed) {
      widget.setShape([]);
      return;
    }
    const content = widget.getContentBounds();
    let rect;
    if (config.dockEdge === 'top') rect = { x: 0, y: 0, width: content.width, height: 8 };
    else if (config.dockEdge === 'left') rect = { x: 0, y: 0, width: 8, height: content.height };
    else if (config.dockEdge === 'right') rect = { x: Math.max(0, content.width - 8), y: 0, width: 8, height: content.height };
    else rect = { x: 0, y: Math.max(0, content.height - 8), width: content.width, height: 8 };
    widget.setShape([rect]);
  } catch {
    // ignore
  }
}

function sendWidgetDockState() {
  if (!widget || widget.isDestroyed()) return;
  widget.webContents.send('dock:state', {
    docked: widgetDocked,
    collapsed: widgetDockCollapsed,
    edge: config.dockEdge,
  });
}

function collapseWidgetDock() {
  if (!widgetDocked || !widget || widget.isDestroyed()) return;
  if (widgetDockMenuOpen) return;
  widgetDockSuppressMoveUntil = Date.now() + 600;
  widgetDockCollapsed = true;
  widget.setBounds(widgetDockBounds(false));
  alignWidgetDock();
  applyWidgetDockShape();
  widget.setAlwaysOnTop(true, 'floating');
  sendWidgetDockState();
}

function expandWidgetDock() {
  if (!widgetDocked || !widget || widget.isDestroyed()) return;
  widgetDockSuppressMoveUntil = Date.now() + 600;
  widgetDockCollapsed = false;
  try {
    widget.setResizable(true);
    widget.setMinimumSize(WIDGET_MIN_WIDTH, WIDGET_MIN_HEIGHT);
  } catch {
    // ignore
  }
  widget.setBounds(widgetDockBounds(true));
  alignWidgetDock();
  applyWidgetDockShape();
  applyAlwaysOnTop();
  sendWidgetDockState();
}

function dockWidget(edge, offset) {
  if (!widget || widget.isDestroyed()) return;
  if (!widgetDocked) {
    const current = widget.getBounds();
    const normal = widgetDockNormalSize();
    widgetDockNormalBounds = {
      x: current.x,
      y: current.y,
      width: normal.width,
      height: normal.height,
    };
    config.windowBounds = { ...widgetDockNormalBounds };
  }
  config.dockEdge = ['top', 'bottom', 'left', 'right'].includes(edge) ? edge : 'bottom';
  config.dockOffset = Math.min(0.95, Math.max(0.05, Number(offset) || 0.5));
  config.dockDocked = true;
  writeConfig();
  widgetDocked = true;
  widget.setResizable(false);
  widget.setMinimumSize(1, 1);
  collapseWidgetDock();
}

function undockWidget(restoreNormal) {
  if (!widget || widget.isDestroyed()) return;
  const current = widget.getBounds();
  const normal = widgetDockNormalSize();
  const baseSize = widgetDockNormalBounds || normal;
  const wasCollapsed = widgetDockCollapsed;
  const shouldResize = Boolean(restoreNormal || wasCollapsed);
  const target = restoreNormal && widgetDockNormalBounds
    ? widgetDockNormalBounds
    : {
        x: current.x,
        y: current.y,
        width: baseSize && baseSize.width ? baseSize.width : normal.width,
        height: baseSize && baseSize.height ? baseSize.height : normal.height,
      };
  widgetDockSuppressMoveUntil = Date.now() + 600;
  widgetDocked = false;
  widgetDockCollapsed = false;
  config.dockDocked = false;
  writeConfig();
  if (shouldResize) {
    try {
      widget.setShape([]);
      widget.setResizable(true);
      widget.setMinimumSize(WIDGET_MIN_WIDTH, WIDGET_MIN_HEIGHT);
    } catch {
      // ignore
    }
    widget.setBounds(target);
  }
  config.windowBounds = {
    x: shouldResize ? target.x : current.x,
    y: shouldResize ? target.y : current.y,
    width: normal.width,
    height: normal.height,
  };
  writeConfig();
  widgetDockNormalBounds = null;
  applyAlwaysOnTop();
  sendWidgetDockState();
}

function applyWidgetDockMode() {
  if (!widget || widget.isDestroyed()) return;
  if (!config.dockEnabled) {
    if (widgetDocked) undockWidget(true);
    return;
  }
  if (config.dockDocked) {
    if (!widgetDocked) {
      const current = widget.getBounds();
      const normal = widgetDockNormalSize();
      widgetDockNormalBounds = {
        x: current.x,
        y: current.y,
        width: normal.width,
        height: normal.height,
      };
      dockWidget(config.dockEdge, config.dockOffset);
    } else {
      collapseWidgetDock();
    }
  } else if (widgetDocked) {
    undockWidget(true);
  }
}

function dockGaps(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  return {
    area,
    gaps: [
      { edge: 'left', value: bounds.x - area.x },
      { edge: 'right', value: (area.x + area.width) - (bounds.x + bounds.width) },
      { edge: 'top', value: bounds.y - area.y },
      { edge: 'bottom', value: (area.y + area.height) - (bounds.y + bounds.height) },
    ],
  };
}

function scheduleWidgetDockCheck() {
  if (!widget || widget.isDestroyed()) return;
  if (Date.now() < widgetDockSuppressMoveUntil) return;
  if (!config.dockEnabled) return;
  if (widgetDockUserMoving) return;
  if (widgetDockCollapsed) return;
  const bounds = widget.getBounds();
  const { area, gaps } = dockGaps(bounds);
  const candidates = gaps
    .filter((item) => item.value <= DOCK_SNAP_PX)
    .sort((a, b) => a.value - b.value);
  const nearest = candidates[0];
  const current = gaps.find((item) => item.edge === config.dockEdge);
  const point = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const offset = nearest && (nearest.edge === 'left' || nearest.edge === 'right')
    ? (point.y - area.y) / Math.max(1, area.height)
    : (point.x - area.x) / Math.max(1, area.width);

  clearTimeout(widgetDockMoveTimer);
  widgetDockMoveTimer = setTimeout(() => {
    if (Date.now() < widgetDockSuppressMoveUntil) return;
    if (widgetDockUserMoving) return;
    if (!widgetDocked) {
      if (nearest) {
        dockWidget(nearest.edge, offset);
      } else {
        widgetDockNormalBounds = null;
      }
    }
  }, 260);
}

function widgetDockBarContains(point) {
  if (!widget || widget.isDestroyed()) return false;
  const content = widget.getContentBounds();
  const pad = 5;
  if (config.dockEdge === 'bottom') {
    return point.x >= content.x - pad
      && point.x <= content.x + content.width + pad
      && point.y >= content.y + content.height - 10 - pad
      && point.y <= content.y + content.height + pad;
  }
  if (config.dockEdge === 'top') {
    return point.x >= content.x - pad
      && point.x <= content.x + content.width + pad
      && point.y >= content.y - pad
      && point.y <= content.y + 10 + pad;
  }
  if (config.dockEdge === 'left') {
    return point.x >= content.x - pad
      && point.x <= content.x + 10 + pad
      && point.y >= content.y - pad
      && point.y <= content.y + content.height + pad;
  }
  return point.x >= content.x + content.width - 10 - pad
    && point.x <= content.x + content.width + pad
    && point.y >= content.y - pad
    && point.y <= content.y + content.height + pad;
}

function watchWidgetDockPosition() {
  if (!widget || widget.isDestroyed()) return;
  const bounds = widget.getBounds();
  const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (!widgetDockLastBounds) {
    widgetDockLastBounds = key;
    widgetDockBoundsChangedAt = Date.now();
    return;
  }
  if (key !== widgetDockLastBounds) {
    widgetDockLastBounds = key;
    widgetDockBoundsChangedAt = Date.now();
    if (Date.now() >= widgetDockSuppressMoveUntil) {
      widgetDockUserMoving = true;
    } else {
      widgetDockPendingCheck = true;
    }
    return;
  }
  if (widgetDockPendingCheck && Date.now() >= widgetDockSuppressMoveUntil) {
    widgetDockPendingCheck = false;
    scheduleWidgetDockCheck();
    return;
  }
  if (widgetDockUserMoving && Date.now() - widgetDockBoundsChangedAt > 600) {
    widgetDockUserMoving = false;
    scheduleWidgetDockCheck();
  }
}

function watchWidgetDockHover() {
  if (widgetDockMenuOpen) return;
  if (!widgetDocked || !widget || widget.isDestroyed() || !config.dockEnabled) return;
  if (!widget.isVisible() || widget.isMinimized()) return;
  if (widgetDockUserMoving) return;
  const cursor = screen.getCursorScreenPoint();
  const scale = screen.getDisplayNearestPoint(cursor).scaleFactor || 1;
  const points = [
    cursor,
    { x: cursor.x / scale, y: cursor.y / scale },
  ];
  if (widgetDockCollapsed) {
    widgetDockHoverLeaveAt = 0;
    if (points.some((point) => widgetDockBarContains(point))) expandWidgetDock();
    return;
  }
  const bounds = widget.getBounds();
  const inside = points.some((point) => point.x >= bounds.x - 3
    && point.x <= bounds.x + bounds.width + 3
    && point.y >= bounds.y - 3
    && point.y <= bounds.y + bounds.height + 3);
  if (inside) {
    widgetDockHoverLeaveAt = 0;
  } else if (!widgetDockHoverLeaveAt) {
    widgetDockHoverLeaveAt = Date.now();
  } else if (Date.now() - widgetDockHoverLeaveAt > 600) {
    widgetDockHoverLeaveAt = 0;
    const { area, gaps } = dockGaps(bounds);
    const current = gaps.find((item) => item.edge === config.dockEdge);
    if (current && current.value > DOCK_UNDOCK_PX) {
      const candidates = gaps
        .filter((item) => item.value <= DOCK_UNDOCK_PX)
        .sort((a, b) => a.value - b.value);
      const nearest = candidates[0];
      if (nearest && nearest.edge !== config.dockEdge) {
        const point = {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        };
        const offset = nearest.edge === 'left' || nearest.edge === 'right'
          ? (point.y - area.y) / Math.max(1, area.height)
          : (point.x - area.x) / Math.max(1, area.width);
        dockWidget(nearest.edge, offset);
      } else {
        undockWidget(false);
      }
    } else {
      collapseWidgetDock();
    }
  }
}

function resizeWidget(width, height) {
  if (!widget || widget.isDestroyed()) return null;
  if (widgetDocked) {
    return { width: widget.getBounds().width, height: widget.getBounds().height };
  }
  const current = widget.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const maxWidth = Math.min(WIDGET_MAX_WIDTH, area.width);
  const maxHeight = Math.min(WIDGET_MAX_HEIGHT, area.height);
  const nextWidth = Math.round(Math.min(maxWidth, Math.max(WIDGET_MIN_WIDTH, Number(width) || current.width)));
  const nextHeight = Math.round(Math.min(maxHeight, Math.max(WIDGET_MIN_HEIGHT, Number(height) || current.height)));
  widget.setSize(nextWidth, nextHeight, false);
  rememberNormalSize(nextWidth, nextHeight);
  scheduleSaveBounds();
  return { width: nextWidth, height: nextHeight };
}

function resetWidgetSize() {
  if (!widget || widget.isDestroyed()) return null;
  widget.setSize(WIDGET_WIDTH, WIDGET_HEIGHT, false);
  rememberNormalSize(WIDGET_WIDTH, WIDGET_HEIGHT);
  scheduleSaveBounds();
  return { width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
}

function initialBounds() {
  const saved = config.windowBounds;
  if (saved) {
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return (
        saved.x + saved.width > area.x &&
        saved.x < area.x + area.width &&
        saved.y + saved.height > area.y &&
        saved.y < area.y + area.height
      );
    });
    if (visible) return saved;
  }
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: area.x + area.width - WIDGET_WIDTH - 24,
    y: area.y + 24,
  };
}

function widgetWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
    backgroundThrottling: false,
    devTools: !app.isPackaged,
  };
}

function sendWidgetRefresh() {
  if (!widget || widget.isDestroyed() || widget.webContents.isDestroyed()) return;
  widget.webContents.send('widget:refresh');
}

function sendWidgetVisibility(hidden) {
  if (!widget || widget.isDestroyed() || widget.webContents.isDestroyed()) return;
  widget.webContents.send('widget:visibility', Boolean(hidden));
}

function createWidget() {
  const bounds = initialBounds();
  widget = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: WIDGET_MIN_WIDTH,
    minHeight: WIDGET_MIN_HEIGHT,
    maxWidth: WIDGET_MAX_WIDTH,
    maxHeight: WIDGET_MAX_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    title: '工资小组件',
    icon: APP_ICON,
    webPreferences: widgetWebPreferences(),
  });

  const page = path.join(__dirname, 'renderer', 'index.html');
  widget.loadFile(page).catch((err) => log('widget loadFile failed', err.message));

  let shownOnce = false;
  const showWidgetWindow = (reason) => {
    if (!widget || widget.isDestroyed() || shownOnce) return;
    shownOnce = true;
    if (config.alwaysOnTop) widget.setAlwaysOnTop(true, 'screen-saver');
    widget.showInactive();
    if (!widget.isVisible()) widget.show();
    widget.moveTop();
    log('widget shown via', reason, 'visible=', widget.isVisible());
  };

  widget.webContents.on('did-start-loading', () => log('widget did-start-loading'));
  widget.webContents.on('dom-ready', () => log('widget dom-ready'));
  widget.webContents.on('did-finish-load', () => {
    log('widget did-finish-load');
    showWidgetWindow('did-finish-load');
    sendWidgetDockState();
  });
  widget.webContents.on('did-fail-load', (_e, code, desc) => log('widget did-fail-load', code, desc));
  widget.webContents.on('render-process-gone', (_e, details) => log('widget render-process-gone', JSON.stringify(details)));
  widget.webContents.on('preload-error', (_e, p, err) => log('widget preload-error', p, err.message));

  widget.once('ready-to-show', () => {
    log('widget ready-to-show');
    showWidgetWindow('ready-to-show');
  });

  // 某些虚拟机/远程桌面上 ready-to-show 可能永远不触发，兜底强制显示
  setTimeout(() => {
    if (!shownOnce) log('widget show fallback triggered');
    showWidgetWindow('fallback');
  }, 2500);

  widget.on('will-move', () => {
    if (Date.now() < widgetDockSuppressMoveUntil) return;
    if (!widgetDocked && !widgetDockNormalBounds) {
      const bounds = widget.getBounds();
      const normal = widgetDockNormalSize();
      widgetDockNormalBounds = {
        x: bounds.x,
        y: bounds.y,
        width: normal.width,
        height: normal.height,
      };
      config.windowBounds = { ...widgetDockNormalBounds };
      writeConfig();
    }
    widgetDockUserMoving = true;
    clearTimeout(widgetDockMoveIdleTimer);
    widgetDockMoveIdleTimer = setTimeout(() => {
      widgetDockUserMoving = false;
      scheduleWidgetDockCheck();
    }, 600);
  });
  widget.on('moved', () => {
    scheduleSaveBounds();
    if (Date.now() >= widgetDockSuppressMoveUntil) {
      widgetDockUserMoving = true;
      clearTimeout(widgetDockMoveIdleTimer);
      widgetDockMoveIdleTimer = setTimeout(() => {
        widgetDockUserMoving = false;
        scheduleWidgetDockCheck();
      }, 600);
    }
    scheduleWidgetDockCheck();
  });
  widget.on('resize', () => {
    if (!widgetDocked && !widgetDockCollapsed) {
      rememberCurrentNormalBounds();
    }
    scheduleSaveBounds();
  });

  widget.on('close', (event) => {
    if (isQuitting) return;

    // 只有托盘真的可用时才隐藏到托盘；否则 × 就是常规的退出
    if (config.minimizeToTray && tray && trayUsable) {
      event.preventDefault();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
      if (config.dockEnabled) {
        if (!widgetDocked) dockWidget(config.dockEdge, config.dockOffset);
        else collapseWidgetDock();
      } else {
        widget.hide();
      }
      if (!trayHintShown) {
        trayHintShown = true;
        try {
          tray.displayBalloon({
            title: '工资小组件',
            content: config.dockEnabled
              ? '已收起到屏幕边缘，鼠标移到进度条即可展开。'
              : '已最小化到托盘。如果托盘里看不到，请点击任务栏右下角的 ^ 展开，或按 Ctrl+Alt+Shift+W 重新显示。',
            iconType: 'info',
          });
        } catch {
          // ignore balloon failures
        }
      }
      return;
    }

    if (config.minimizeToTray) log('tray unavailable, close quits');
    isQuitting = true;
    app.quit();
  });

  widget.on('show', () => {
    sendWidgetVisibility(false);
    sendWidgetRefresh();
    refreshTrayMenu();
  });
  widget.on('hide', () => {
    sendWidgetVisibility(true);
    refreshTrayMenu();
  });
  widget.on('minimize', (event) => {
    if (config.dockEnabled) {
      if (typeof event?.preventDefault === 'function') event.preventDefault();
      setImmediate(() => {
        if (!widget || widget.isDestroyed()) return;
        if (widget.isMinimized()) widget.restore();
        if (!widgetDocked) dockWidget(config.dockEdge, config.dockOffset);
        else collapseWidgetDock();
      });
      return;
    }
    sendWidgetVisibility(true);
  });
  widget.on('restore', () => {
    sendWidgetVisibility(false);
    sendWidgetRefresh();
  });
  widget.on('focus', sendWidgetRefresh);

  widget.on('closed', () => {
    widget = null;
  });
}

function ensureWidgetOnScreen() {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
    const overlapY = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
    return overlapX > 80 && overlapY > 60;
  });
  if (!visible) {
    const area = screen.getPrimaryDisplay().workArea;
    widget.setBounds({
      x: area.x + area.width - WIDGET_WIDTH - 24,
      y: area.y + 24,
      width: WIDGET_WIDTH,
      height: WIDGET_HEIGHT,
    });
    log('widget bounds reset to visible area');
  }
}

function showWidget() {
  if (!widget) {
    createWidget();
    return;
  }
  ensureWidgetOnScreen();
  if (widget.isMinimized()) widget.restore();
  widget.show();
  widget.moveTop();
  if (widgetDocked && widgetDockCollapsed) expandWidgetDock();
}

function toggleWidget() {
  if (!widget) return;
  if (widget.isVisible()) widget.hide();
  else showWidget();
}

function settingsBounds() {
  const wb = widget && !widget.isDestroyed()
    ? widget.getBounds()
    : { x: 0, y: 0, width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
  const display = widget && !widget.isDestroyed()
    ? screen.getDisplayMatching(wb)
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const height = Math.min(820, area.height - 20);
  const gap = 16;

  // 优先放在小组件左侧，空间不足时放右侧，最后兜底居中
  let x = wb.x - SETTINGS_WIDTH - gap;
  if (x < area.x + gap) x = wb.x + wb.width + gap;
  if (x + SETTINGS_WIDTH > area.x + area.width - gap) {
    x = area.x + (area.width - SETTINGS_WIDTH) / 2;
  }
  const y = Math.round(Math.max(area.y + 16, area.y + (area.height - height) / 2));
  return {
    x: Math.round(x),
    y,
    width: SETTINGS_WIDTH,
    height,
  };
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const b = settingsBounds();
  settingsWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    title: '工资小组件 · 设置',
    icon: APP_ICON,
    webPreferences: widgetWebPreferences(),
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html')).catch((err) => {
    log('settings loadFile failed', err.message);
  });

  let settingsShown = false;
  const showSettings = (reason) => {
    if (!settingsWin || settingsWin.isDestroyed() || settingsShown) return;
    settingsShown = true;
    settingsWin.show();
    settingsWin.focus();
    log('settings shown via', reason);
  };

  settingsWin.webContents.on('did-finish-load', () => {
    log('settings did-finish-load');
    showSettings('did-finish-load');
  });
  settingsWin.webContents.on('preload-error', (_e, p, err) => log('settings preload-error', p, err.message));
  settingsWin.once('ready-to-show', () => showSettings('ready-to-show'));
  setTimeout(() => showSettings('fallback'), 2500);
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function centeredWindowBounds(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function openLeaveDialog() {
  if (leaveWin && !leaveWin.isDestroyed()) {
    leaveWin.show();
    leaveWin.focus();
    return;
  }
  const width = 560;
  const height = 760;
  const b = centeredWindowBounds(width, height);
  leaveWin = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    title: '工资小组件 · 请假',
    icon: APP_ICON,
    webPreferences: widgetWebPreferences(),
  });
  leaveWin.loadFile(path.join(__dirname, 'renderer', 'leave.html')).catch((err) => {
    log('leave loadFile failed', err.message);
  });
  let shown = false;
  const show = (reason) => {
    if (!leaveWin || leaveWin.isDestroyed() || shown) return;
    shown = true;
    leaveWin.show();
    leaveWin.focus();
    log('leave shown via', reason);
  };
  leaveWin.webContents.on('did-finish-load', () => show('did-finish-load'));
  leaveWin.once('ready-to-show', () => show('ready-to-show'));
  setTimeout(() => show('fallback'), 2500);
  leaveWin.on('closed', () => {
    leaveWin = null;
  });
}

function openSalaryReport() {
  if (reportWin && !reportWin.isDestroyed()) {
    reportWin.show();
    reportWin.focus();
    reportWin.webContents.send('report:refresh');
    return;
  }
  const width = 980;
  const height = 700;
  const b = centeredWindowBounds(width, height);
  reportWin = new BrowserWindow({
    ...b,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    title: '工资小组件 · 当月薪资',
    icon: APP_ICON,
    webPreferences: widgetWebPreferences(),
  });
  reportWin.loadFile(path.join(__dirname, 'renderer', 'report.html')).catch((err) => {
    log('report loadFile failed', err.message);
  });
  let shown = false;
  const show = (reason) => {
    if (!reportWin || reportWin.isDestroyed() || shown) return;
    shown = true;
    reportWin.show();
    reportWin.focus();
    log('report shown via', reason);
  };
  reportWin.webContents.on('did-finish-load', () => show('did-finish-load'));
  reportWin.once('ready-to-show', () => show('ready-to-show'));
  setTimeout(() => show('fallback'), 2500);
  reportWin.on('closed', () => {
    reportWin = null;
  });
}

function getAutostart() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setAutostart(enabled) {
  try {
    // 开机自启同样带上 --no-sandbox，避免自启时静默失败
    const args = app.isPackaged ? ['--no-sandbox'] : [app.getAppPath(), '--no-sandbox'];
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args,
    });
    return getAutostart();
  } catch (err) {
    log('autostart failed', err.message);
    return getAutostart();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: widget && widget.isVisible() ? '隐藏小组件' : '显示小组件',
      click: toggleWidget,
    },
    { label: '设置…', click: openSettings },
    { label: '请假…', click: openLeaveDialog },
    { label: '查看当月薪资…', click: openSalaryReport },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: Boolean(config.alwaysOnTop),
      click: (item) => {
        config.alwaysOnTop = item.checked;
        writeConfig();
        applyAlwaysOnTop();
        broadcast('config:changed', publicConfig());
        refreshTrayMenu();
      },
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: getAutostart(),
      click: (item) => {
        setAutostart(item.checked);
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function showWidgetMenu() {
  if (!widget || widget.isDestroyed()) return;

  const menu = Menu.buildFromTemplate([
    { label: '设置…', click: openSettings },
    { label: '请假…', click: openLeaveDialog },
    { label: '查看当月薪资…', click: openSalaryReport },
    {
      label: '最小化到任务栏',
      click: () => {
        if (widget && !widget.isDestroyed()) widget.minimize();
      },
    },
    {
      label: '恢复默认窗口大小',
      click: () => {
        resetWidgetSize();
      },
    },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: Boolean(config.alwaysOnTop),
      click: (item) => {
        config.alwaysOnTop = item.checked;
        writeConfig();
        applyAlwaysOnTop();
        broadcast('config:changed', publicConfig());
        refreshTrayMenu();
      },
    },
    {
      label: '关闭时最小化到托盘',
      type: 'checkbox',
      checked: Boolean(config.minimizeToTray),
      click: (item) => {
        config.minimizeToTray = item.checked;
        writeConfig();
        broadcast('config:changed', publicConfig());
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  widgetDockMenuOpen = true;
  widgetDockHoverLeaveAt = 0;
  menu.popup({
    window: widget,
    callback: () => {
      widgetDockMenuOpen = false;
      widgetDockHoverLeaveAt = 0;
      if (widget && !widget.isDestroyed()) {
        widget.webContents.send('dock:menu-closed');
      }
    },
  });
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const trayPng = path.join(__dirname, 'assets', 'tray.png');
  let image = nativeImage.createEmpty();
  try {
    // 从内存加载 16×16 PNG，避免中文路径和 DPI 缩放带来的兼容问题
    image = nativeImage.createFromBuffer(fs.readFileSync(trayPng), { scaleFactor: 1 });
  } catch (err) {
    log('tray png read failed:', err.message);
  }
  if (image.isEmpty()) {
    image = nativeImage
      .createFromPath(APP_ICON)
      .resize({ width: 16, height: 16, quality: 'best' });
  }
  if (image.isEmpty()) {
    log('tray icon image is empty');
    throw new Error('tray icon is empty');
  }
  log('tray image size=', JSON.stringify(image.getSize()));

  tray = new Tray(image);
  tray.setToolTip('工资小组件 · 右键可设置或退出');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', showWidget);

  try {
    const bounds = tray.getBounds();
    log('tray bounds=', JSON.stringify(bounds));
    trayUsable = Boolean(bounds && bounds.width > 0 && bounds.height > 0);
    if (!trayUsable) {
      // 图标没有真正进入通知区域时，给一个任务栏入口作为兜底
      log('tray icon has no bounds, enabling taskbar fallback');
      if (widget && !widget.isDestroyed()) widget.setSkipTaskbar(false);
    }
  } catch (err) {
    trayUsable = false;
    log('tray bounds failed', err.message);
  }
}

function bindIpc() {
  ipcMain.handle('config:get', () => publicConfig());

  ipcMain.handle('config:save', (_event, patch) => {
    const incoming = { ...(patch || {}) };
    const previousKey = config.holidayApiKey;
    const previousEnabled = config.holidayApiEnabled;

    let nextKey = config.holidayApiKey;
    let nextEnc = config.holidayApiKeyEnc || '';
    if (incoming.holidayApiKeyClear) {
      nextKey = '';
      nextEnc = '';
    } else if (typeof incoming.holidayApiKey === 'string' && incoming.holidayApiKey.trim()) {
      const plain = incoming.holidayApiKey.trim();
      nextEnc = encryptHolidayApiKey(plain);
      nextKey = plain;
    }
    delete incoming.holidayApiKey;
    delete incoming.holidayApiKeyClear;
    incoming.holidayApiKeyEnc = nextEnc;

    config = sanitizeConfig({ ...config, ...incoming });
    config.holidayApiKey = nextKey;
    config.holidayApiKeyEnc = nextEnc;
    writeConfig();
    applyAlwaysOnTop();
    applyWidgetDockMode();
    broadcast('config:changed', publicConfig());
    broadcast('holidays:changed', mergedHolidayPayload());
    refreshTrayMenu();
    if (config.holidayApiEnabled && config.holidayApiKey) {
      const force = !previousEnabled || previousKey !== config.holidayApiKey;
      syncHolidayApi(force, 'auto').catch((err) => log('holiday api auto sync failed', err.message));
    }
    return publicConfig();
  });

  ipcMain.handle('widget:hide', () => {
    if (widget) widget.hide();
  });

  ipcMain.handle('widget:close', () => {
    if (widget) widget.close();
  });

  ipcMain.on('widget:context-menu', () => showWidgetMenu());

  ipcMain.handle('widget:pin', (_event, value) => {
    config.alwaysOnTop = Boolean(value);
    writeConfig();
    applyAlwaysOnTop();
    broadcast('config:changed', publicConfig());
    refreshTrayMenu();
    return config.alwaysOnTop;
  });

  ipcMain.handle('widget:resize', (_event, width, height) => resizeWidget(width, height));

  ipcMain.handle('settings:open', () => openSettings());
  ipcMain.handle('settings:close', () => {
    if (settingsWin) settingsWin.close();
  });

  ipcMain.handle('leave:open', () => openLeaveDialog());
  ipcMain.handle('leave:close', () => {
    if (leaveWin) leaveWin.close();
  });
  ipcMain.handle('report:open', () => openSalaryReport());
  ipcMain.handle('report:close', () => {
    if (reportWin) reportWin.close();
  });

  ipcMain.handle('records:get', () => (recordsStore ? recordsStore.payload() : { leaves: {}, ot: {} }));
  ipcMain.handle('records:set-leave', (_event, date, type, start, end) => {
    if (!recordsStore) return { ok: false, error: '请假记录模块未初始化' };
    try {
      return { ok: true, records: recordsStore.setLeave(date, type, start, end) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('records:remove-leave', (_event, date) => {
    if (!recordsStore) return { ok: false, error: '请假记录模块未初始化' };
    try {
      return { ok: true, records: recordsStore.removeLeave(date) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('records:add-ot', (_event, date, ms) => {
    if (!recordsStore) return { ok: false };
    try {
      return { ok: true, records: recordsStore.addOvertime(date, ms) };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.on('dock:release', () => {
    if (!widget || widget.isDestroyed() || !widgetDocked || widgetDockCollapsed) return;
    if (Date.now() < widgetDockSuppressMoveUntil) return;
    const bounds = widget.getBounds();
    const { area, gaps } = dockGaps(bounds);
    const current = gaps.find((item) => item.edge === config.dockEdge);
    const candidates = gaps
      .filter((item) => item.value <= DOCK_UNDOCK_PX)
      .sort((a, b) => a.value - b.value);
    const nearest = candidates[0];
    if (current && current.value > DOCK_UNDOCK_PX) {
      const near = gaps
        .filter((item) => item.value <= DOCK_UNDOCK_PX)
        .sort((a, b) => a.value - b.value)[0];
      if (near && near.edge !== config.dockEdge) {
        const point = {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        };
        const offset = near.edge === 'left' || near.edge === 'right'
          ? (point.y - area.y) / Math.max(1, area.height)
          : (point.x - area.x) / Math.max(1, area.width);
        dockWidget(near.edge, offset);
      } else {
        undockWidget(false);
      }
      return;
    }
    if (nearest && nearest.edge !== config.dockEdge) {
      const point = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
      const offset = nearest.edge === 'left' || nearest.edge === 'right'
        ? (point.y - area.y) / Math.max(1, area.height)
        : (point.x - area.x) / Math.max(1, area.width);
      dockWidget(nearest.edge, offset);
    }
  });

  ipcMain.handle('autostart:get', () => getAutostart());
  ipcMain.handle('autostart:set', (_event, enabled) => {
    const value = setAutostart(enabled);
    refreshTrayMenu();
    return value;
  });

  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('holidays:get', () => mergedHolidayPayload());
  ipcMain.handle('holidays:status', () => holidayStatus());
  ipcMain.handle('holidays:api-status', () => holidayApiStatus());
  ipcMain.handle('holidays:sync-api', (_event, force, source) => (
    syncHolidayApi(Boolean(force), source === 'manual' ? 'manual' : 'auto')
  ));
  ipcMain.handle('holidays:import', async () => {
    if (!holidayStore) return { ok: false, error: '节假日模块未初始化' };
    const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : widget;
    const result = await dialog.showOpenDialog(parent, {
      title: '选择节假日数据文件',
      properties: ['openFile'],
      filters: [
        { name: '节假日数据 (JSON)', extensions: ['json', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    try {
      return holidayStore.importFile(result.filePaths[0]);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('holidays:open-folder', async () => {
    if (!holidayStore) return { ok: false, error: '节假日模块未初始化' };
    try {
      fs.mkdirSync(holidayStore.folderPath, { recursive: true });
      const error = await shell.openPath(holidayStore.folderPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('holidays:open-url', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: '请填写 http(s) 网址' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('holidays:clear', () => {
    if (!holidayStore) return { years: [], holidays: 0, workdays: 0, sources: [], importedAt: 0 };
    return holidayStore.clear();
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// 单实例检测使用本机回环端口，不依赖 userData 目录是否可写。
// 第二个实例启动时会先 bind 失败，再通过 /ping 判断端口上是不是本程序：
// 是则提示“已经在运行”，不是（端口被其他软件占用）则继续启动。
const INSTANCE_PORT = 47823;
let instanceServer = null;

function pingExistingInstance() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: INSTANCE_PORT, path: '/ping', timeout: 700 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 64) req.destroy();
        });
        res.on('end', () => resolve(body.trim() === 'salary-widget'));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function askExistingToShow() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: INSTANCE_PORT, path: '/show', timeout: 700 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function acquireInstanceLock() {
  if (process.env.SALARY_WIDGET_NO_SINGLE) return Promise.resolve(true);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('salary-widget');
        return;
      }
      if (req.url === '/show') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        setImmediate(() => {
          try {
            log('existing instance requested show');
            showWidget();
          } catch (err) {
            log('show existing failed', err.message);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        const existing = await pingExistingInstance();
        log('instance port in use, existing=', existing);
        if (existing) {
          const shown = await askExistingToShow();
          existingInstanceShown = shown;
          log('asked existing instance to show, result=', shown);
          resolve(false);
        } else {
          // 端口被其他软件占用，不阻止本程序启动
          resolve(true);
        }
      } else {
        log('instance port error:', err.message);
        // 端口不可用时不阻止程序启动
        resolve(true);
      }
    });
    server.listen(INSTANCE_PORT, '127.0.0.1', () => {
      instanceServer = server;
      log('instance lock acquired on port', INSTANCE_PORT);
      resolve(true);
    });
  });
}

function releaseInstanceLock() {
  if (instanceServer) {
    try {
      instanceServer.close();
    } catch {
      // ignore
    }
    instanceServer = null;
  }
  try {
    // 清理旧版本留下的文件锁
    const file = path.join(app.getPath('userData'), 'instance.lock');
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  saveBounds();
  releaseInstanceLock();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.whenReady()
  .then(async () => {
    log('app ready, userData=', app.getPath('userData'));

    const gotLock = await acquireInstanceLock();
    if (!gotLock) {
      if (!existingInstanceShown) {
        dialog.showMessageBoxSync({
          type: 'info',
          title: '工资小组件',
          message: '工资小组件已经在运行',
          detail: '请查看任务栏上的“工资小组件”按钮，或按 Ctrl+Alt+Shift+W 重新显示。',
          buttons: ['知道了'],
          noLink: true,
        });
      }
      app.quit();
      return;
    }

    loadConfig();
    holidayStore = createHolidayStore({
      dataDir: app.getPath('userData'),
      log,
      onChange: () => {
        try {
          broadcast('holidays:changed', holidayStore ? holidayStore.payload() : null);
        } catch (err) {
          log('holiday broadcast failed', err.message);
        }
      },
    });
    holidayStore.load();
    holidayStore.scan();
    holidayStore.watch();
    recordsStore = createRecordsStore({
      dataDir: app.getPath('userData'),
      log,
      onChange: (records) => {
        try {
          broadcast('records:changed', records);
        } catch (err) {
          log('records broadcast failed', err.message);
        }
      },
    });
    recordsStore.load();
    loadHolidayApiCache();
    loadHolidayApiUsage();
    bindIpc();
    createWidget();
    applyWidgetDockMode();
    setInterval(watchWidgetDockHover, 120);
    setInterval(watchWidgetDockPosition, 120);
    screen.on('display-metrics-changed', () => {
      if (widgetDocked) collapseWidgetDock();
    });
    screen.on('display-removed', () => {
      if (widgetDocked) undockWidget(true);
    });
    try {
      createTray();
      log('tray ready');
    } catch (err) {
      log('tray failed', err.message);
      if (widget && !widget.isDestroyed()) widget.setSkipTaskbar(false);
    }

    // 如果托盘没有真正注册成功，等 2.5 秒后重建一次（有些环境 Explorer 就绪较晚）
    if (!trayUsable) {
      setTimeout(() => {
        if (isQuitting) return;
        try {
          if (tray) {
            tray.destroy();
            tray = null;
          }
          createTray();
          log('tray recreated, usable=', trayUsable);
        } catch (err) {
          log('tray retry failed', err.message);
        }
      }, 2500);
    }

    try {
      hotkeyRegistered = globalShortcut.register('CommandOrControl+Alt+Shift+W', showWidget);
      log('hotkey registered=', hotkeyRegistered);
    } catch (err) {
      hotkeyRegistered = false;
      log('hotkey failed', err.message);
    }
    log('widget created');
    if (config.holidayApiEnabled && config.holidayApiKey) {
      setTimeout(() => {
        syncHolidayApi(false).catch((err) => log('holiday api startup sync failed', err.message));
      }, 1200);
    }
    if (firstRun) setTimeout(openSettings, 700);
    if (process.env.SALARY_WIDGET_CAPTURE) {
      setTimeout(async () => {
        await captureWindow(widget, 'widget-capture.png');
        if (settingsWin && !settingsWin.isDestroyed()) {
          await captureWindow(settingsWin, 'settings-capture.png');
        }
      }, 2200);
    }
  })
  .catch((err) => log('whenReady failed', err.stack || err.message));

app.on('activate', () => showWidget());

app.on('window-all-closed', () => {
  // 有托盘时常驻；没有托盘（创建失败）时退出，避免留下不可见的进程
  if (!tray) app.quit();
});
