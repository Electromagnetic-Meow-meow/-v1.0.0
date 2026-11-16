'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeDate(value, defaultYear) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = text.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/);
    if (!match || !defaultYear) return null;
    year = Number(defaultYear);
    month = Number(match[1]);
    day = Number(match[2]);
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function yearFromFileName(fileName) {
  const match = String(fileName || '').match(/(20\d{2})/);
  return match ? Number(match[1]) : null;
}

function parseHolidayJson(text, fileName) {
  const raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  const defaultYear = Number(raw && raw.year) || yearFromFileName(fileName);
  const years = {};

  const bucket = (year) => {
    if (!years[year]) years[year] = { holidays: {}, workdays: [], statutory: [] };
    return years[year];
  };

  const addStatutory = (date, fallbackYear) => {
    const key = normalizeDate(date, fallbackYear || defaultYear);
    if (!key) return;
    const item = bucket(key.slice(0, 4));
    if (!item.statutory.includes(key)) item.statutory.push(key);
  };

  const add = (date, isOffDay, name, fallbackYear) => {
    const key = normalizeDate(date, fallbackYear || defaultYear);
    if (!key) return;
    const year = key.slice(0, 4);
    const item = bucket(year);
    if (isOffDay) {
      if (!item.holidays[key]) {
        const label = name === undefined || name === null ? '' : String(name).trim();
        item.holidays[key] = label || '节假日';
      }
    } else if (!item.workdays.includes(key)) {
      item.workdays.push(key);
    }
  };

  const addList = (list, isOffDay) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry === 'string') {
        add(entry, isOffDay);
      } else if (entry && typeof entry === 'object') {
        add(entry.date || entry.day, isOffDay, entry.name);
      }
    }
  };

  if (Array.isArray(raw)) {
    addList(raw, true);
  } else if (Array.isArray(raw.days)) {
    for (const entry of raw.days) {
      if (!entry || typeof entry !== 'object') continue;
      add(entry.date || entry.day, entry.isOffDay !== false, entry.name);
      if (Number(entry.wage) >= 3) addStatutory(entry.date || entry.day);
    }
  } else {
    const holidays = raw.holidays || raw.offDays || raw.offDaysList;
    if (Array.isArray(holidays)) {
      addList(holidays, true);
    } else if (holidays && typeof holidays === 'object') {
      for (const [date, name] of Object.entries(holidays)) add(date, true, name);
    }

    const workdays = raw.workdays || raw.makeupDays || raw.workDays || raw.workdayList;
    addList(workdays, false);

    const statutory = raw.statutory || raw.statutoryHolidays;
    if (Array.isArray(statutory)) {
      for (const date of statutory) addStatutory(date);
    }

    if (raw.names && typeof raw.names === 'object') {
      for (const [date, name] of Object.entries(raw.names)) {
        const key = normalizeDate(date, defaultYear);
        if (key) bucket(key.slice(0, 4)).holidays[key] = String(name);
      }
    }
  }

  for (const item of Object.values(years)) {
    item.workdays.sort();
    if (item.statutory.length === 0) {
      item.statutory = Object.keys(item.holidays);
    }
  }
  return { years };
}

function createHolidayStore({ dataDir, log = () => {}, onChange = () => {} }) {
  const folder = path.join(dataDir, 'holidays');
  const storeFile = path.join(dataDir, 'holidays-data.json');
  let data = { years: {}, sources: [], importedAt: 0 };
  let watcher = null;
  let scanTimer = null;
  const signatures = new Map();

  function ensureFolder() {
    fs.mkdirSync(folder, { recursive: true });
  }

  function load() {
    try {
      if (!fs.existsSync(storeFile)) return;
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      if (raw && raw.years && typeof raw.years === 'object') {
        data = {
          years: raw.years,
          sources: Array.isArray(raw.sources) ? raw.sources : [],
          importedAt: Number(raw.importedAt) || 0,
        };
      }
    } catch (err) {
      log('holiday load failed', err.message);
    }
  }

  function save() {
    try {
      ensureFolder();
      const tmp = `${storeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, storeFile);
    } catch (err) {
      log('holiday save failed', err.message);
    }
  }

  function summary() {
    const years = Object.keys(data.years).sort();
    let holidays = 0;
    let workdays = 0;
    for (const item of Object.values(data.years)) {
      holidays += Object.keys(item.holidays || {}).length;
      workdays += (item.workdays || []).length;
    }
    return {
      years,
      holidays,
      workdays,
      sources: data.sources.slice(),
      importedAt: data.importedAt,
    };
  }

  function payload() {
    const holidays = {};
    const workdays = [];
    const statutory = [];
    for (const item of Object.values(data.years)) {
      Object.assign(holidays, item.holidays || {});
      for (const date of item.workdays || []) {
        if (!workdays.includes(date)) workdays.push(date);
      }
      const itemStatutory = Array.isArray(item.statutory) && item.statutory.length
        ? item.statutory
        : Object.keys(item.holidays || {});
      for (const date of itemStatutory) {
        if (!statutory.includes(date)) statutory.push(date);
      }
    }
    return {
      ...summary(),
      holidays,
      workdays: workdays.sort(),
      statutory: statutory.sort(),
    };
  }

  function merge(parsed, sourceName) {
    const importedYears = Object.keys(parsed.years);
    if (importedYears.length === 0) {
      throw new Error('文件中没有识别到节假日数据');
    }
    const importedAt = new Date().toISOString();
    for (const year of importedYears) {
      data.years[year] = {
        holidays: parsed.years[year].holidays,
        workdays: parsed.years[year].workdays,
        statutory: parsed.years[year].statutory || [],
        source: sourceName,
        importedAt,
      };
    }
    if (!data.sources.includes(sourceName)) data.sources.push(sourceName);
    data.importedAt = Date.now();
    save();
    onChange();
    return summary();
  }

  function importText(text, sourceName) {
    let parsed;
    try {
      parsed = parseHolidayJson(text, sourceName);
    } catch (err) {
      throw new Error(`不是有效的节假日 JSON：${err.message}`);
    }
    return merge(parsed, sourceName);
  }

  function importFile(filePath) {
    ensureFolder();
    const source = path.resolve(filePath);
    const name = path.basename(source);
    const target = path.join(folder, name);
    if (source.toLowerCase() !== target.toLowerCase()) {
      fs.copyFileSync(source, target);
    }
    const text = fs.readFileSync(target, 'utf8');
    const status = importText(text, name);
    try {
      const stat = fs.statSync(target);
      signatures.set(target, `${stat.mtimeMs}-${stat.size}`);
    } catch {
      // ignore
    }
    return { ok: true, status };
  }

  function scan() {
    try {
      ensureFolder();
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(json|txt)$/i.test(entry.name)) continue;
        const full = path.join(folder, entry.name);
        try {
          const stat = fs.statSync(full);
          const signature = `${stat.mtimeMs}-${stat.size}`;
          if (signatures.get(full) === signature) continue;
          importFile(full);
          signatures.set(full, signature);
          log('holiday imported from folder', entry.name);
        } catch (err) {
          log('holiday file skipped', entry.name, err.message);
        }
      }
    } catch (err) {
      log('holiday scan failed', err.message);
    }
  }

  function watch() {
    if (watcher) return;
    try {
      ensureFolder();
      watcher = fs.watch(folder, { persistent: false }, () => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 800);
      });
    } catch (err) {
      log('holiday watch failed', err.message);
    }
  }

  function clear() {
    data = { years: {}, sources: [], importedAt: 0 };
    signatures.clear();
    save();
    try {
      ensureFolder();
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isFile()) fs.rmSync(path.join(folder, entry.name), { force: true });
      }
    } catch (err) {
      log('holiday clear folder failed', err.message);
    }
    onChange();
    return summary();
  }

  return {
    folderPath: folder,
    load,
    scan,
    watch,
    importFile,
    importText,
    clear,
    payload,
    status: summary,
  };
}

module.exports = {
  createHolidayStore,
  parseHolidayJson,
  normalizeDate,
};
