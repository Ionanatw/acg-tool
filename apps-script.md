// ACG Event — Google Apps Script
// 綁定於 Google Sheet（ACG_event）
// 開啟方式：ACG_event → 擴充功能 → Apps Script
// 最後更新：2026-04-27
// 欄位：A-N 資料、O img（手動）、P threads（城市）、Q threads_loc（地點）

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var year = data.start_date ? data.start_date.split('/')[0] : '';
    var sheet = (year && ss.getSheetByName(year)) || ss.getSheetByName('2026');
    if (!sheet) return json({ error: 'Sheet not found' });

    var row = new Array(17).fill('');
    row[0]  = data.title         || '';
    row[1]  = data.region        || '';
    row[2]  = data.location      || '';
    row[3]  = data.city          || '';
    row[4]  = data.organizer     || '';
    row[5]  = data.start_date    || '';
    row[6]  = data.end_date      || '';
    row[7]  = data.timezone      || '';
    row[8]  = data.event_time    || '';
    row[9]  = data.website_url   || '';
    row[10] = data.twitter_url   || '';
    row[11] = data.facebook_url  || '';
    row[12] = data.instagram_url || '';
    row[13] = data.bluesky_url   || '';
    row[14] = '';
    row[15] = calcThreads(data.start_date, data.end_date, data.title, data.city);
    row[16] = calcThreadsLoc(data.start_date, data.end_date, data.title, data.location);

    sheet.appendRow(row);
    SpreadsheetApp.flush();
    sortSheet(sheet);
    return json({ status: 'ok', title: data.title });
  } catch (err) {
    return json({ error: err.toString() });
  }
}

function manualSort() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('2026');
  var lastRow = sheet.getLastRow();
  if (lastRow <= 2) return;

  sheet.getRange(2, 16, lastRow - 1, 2).clearContent();

  var dataRange = sheet.getRange(2, 1, lastRow - 1, 17);
  var values = dataRange.getValues();
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    values[i][15] = calcThreads(r[5], r[6], r[0], r[3]);
    values[i][16] = calcThreadsLoc(r[5], r[6], r[0], r[2]);
  }
  dataRange.setValues(values);
  sortSheet(sheet);
}

function sortSheet(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 2) return;

  var dataRange = sheet.getRange(2, 1, lastRow - 1, 17);
  var values = dataRange.getValues();
  values.sort(function(a, b) { return toDate(a[5]) - toDate(b[5]); });
  dataRange.setValues(values);

  sheet.getRange(2, 6, lastRow - 1).setNumberFormat('yyyy/mm/dd');
  sheet.getRange(2, 7, lastRow - 1).setNumberFormat('yyyy/mm/dd');
}

function calcThreads(startDate, endDate, title, city) {
  if (!startDate || !title) return '';
  var fmt = function(d) {
    var p = String(d instanceof Date
      ? (d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate())
      : d).split('/');
    return String(parseInt(p[1])).padStart(2,'0') + '/' + String(parseInt(p[2])).padStart(2,'0');
  };
  var cityShort = (city || '').replace(/(市|縣|都|府|県)$/, '');
  var loc = cityShort ? '　📍 ' + cityShort : '';
  var sameDay = !endDate || toDate(endDate).getTime() === toDate(startDate).getTime();
  return sameDay
    ? fmt(startDate) + '：' + title + loc
    : fmt(startDate) + '-' + fmt(endDate) + '：' + title + loc;
}

function calcThreadsLoc(startDate, endDate, title, location) {
  if (!startDate || !title) return '';
  var fmt = function(d) {
    var p = String(d instanceof Date
      ? (d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate())
      : d).split('/');
    return String(parseInt(p[1])).padStart(2,'0') + '/' + String(parseInt(p[2])).padStart(2,'0');
  };
  var loc = location ? '　📍 ' + location : '';
  var sameDay = !endDate || toDate(endDate).getTime() === toDate(startDate).getTime();
  return sameDay
    ? fmt(startDate) + '：' + title + loc
    : fmt(startDate) + '-' + fmt(endDate) + '：' + title + loc;
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (!v) return new Date(0);
  var p = String(v).split('/');
  return new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]));
}

function doGet(e) {
  return json({ status: 'ok', message: 'ACG Event Webhook is running' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
