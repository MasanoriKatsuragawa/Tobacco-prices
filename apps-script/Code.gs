/**
 * 製造たばこ小売定価 統合データ — スプレッドシート側の取り込みスクリプト
 *
 * Google Cloud のサービスアカウントを一切使わずにシートを更新するための方式。
 * このスクリプトはシートの所有者（あなた）の権限で動くので、
 * Google 側の認証情報は不要。必要なのは GitHub の読み取りトークンだけ。
 *
 *   GitHub Actions  … 財務省サイトの巡回・PDF解析・CSV生成（Google認証なし）
 *   Apps Script     … 生成されたCSVを取りに行ってシートに書く（GCPなし）
 *
 * セットアップは apps-script/README.md を参照。
 */

/** スクリプトプロパティのキー。値は「プロジェクトの設定 > スクリプト プロパティ」で設定する。 */
var PROP = {
  repo: 'GITHUB_REPO', // 例: MasanoriKatsuragawa/Tobacco-prices
  ref: 'GITHUB_REF', // 例: main
  token: 'GITHUB_TOKEN', // fine-grained PAT（Contents: Read-only）。公開リポジトリなら不要
  lastSha: 'LAST_SYNCED_SHA', // 前回取り込んだCSVのblob SHA（スクリプトが自動で書く）
};

var PATHS = {
  csv: 'data/tobacco-retail-prices.csv',
  approvals: 'data/approvals.json',
};

var TABS = {
  prices: '定価一覧',
  approvals: '認可一覧',
  readme: 'このシートについて',
};

var SOURCE_URL = 'https://www.mof.go.jp/policy/tab_salt/topics/kouriteika.html';

/** 一度の setValues で書き込む行数。大きすぎると実行時間の上限に当たる。 */
var CHUNK_ROWS = 5000;

/**
 * メニューから手動実行できるようにする。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('データ更新')
    .addItem('GitHubから取り込む', 'updateFromGitHub')
    .addItem('強制的に取り込む（変更が無くても）', 'forceUpdateFromGitHub')
    .addItem('毎日の自動更新を設定する', 'installDailyTrigger')
    .addToUi();
}

/** 日次トリガーの入口。内容に変化が無ければ何もしない。 */
function updateFromGitHub() {
  sync_(false);
}

/** 変更の有無にかかわらず書き直す。 */
function forceUpdateFromGitHub() {
  sync_(true);
}

/**
 * 毎日 07:00 JST に updateFromGitHub を走らせるトリガーを作る。
 * 二重登録を避けるため、既存の同名トリガーは消してから作る。
 */
function installDailyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'updateFromGitHub') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('updateFromGitHub').timeBased().atHour(7).everyDays(1).inTimezone('Asia/Tokyo').create();
  log_('毎日 07:00 (JST) の自動更新を設定しました。');
}

function sync_(force) {
  var props = PropertiesService.getScriptProperties();
  var repo = required_(props, PROP.repo);
  var ref = props.getProperty(PROP.ref) || 'main';

  var csvFile = fetchGitHubFile_(repo, PATHS.csv, ref);

  if (!force && csvFile.sha === props.getProperty(PROP.lastSha)) {
    log_('前回から変更がないため、書き込みをスキップしました。');
    return;
  }

  var rows = parseCsv_(csvFile.content);
  if (rows.length < 2) {
    throw new Error('CSVに行がありません。空のデータでシートを上書きしないよう中断します。');
  }

  var approvals = [];
  try {
    approvals = JSON.parse(fetchGitHubFile_(repo, PATHS.approvals, ref).content);
  } catch (e) {
    // 認可一覧は補助情報。取れなくても定価一覧の更新は続ける。
    log_('認可一覧を取得できませんでした: ' + e);
  }

  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  writeTab_(spreadsheet, TABS.prices, rows);
  if (approvals.length > 0) {
    writeTab_(spreadsheet, TABS.approvals, approvalRows_(approvals, rows));
  }
  writeTab_(spreadsheet, TABS.readme, readmeRows_(rows.length - 1, approvals.length, repo));

  formatTab_(spreadsheet.getSheetByName(TABS.prices));
  formatTab_(spreadsheet.getSheetByName(TABS.approvals));
  removeEmptyDefaultTab_(spreadsheet);

  props.setProperty(PROP.lastSha, csvFile.sha);
  log_(TABS.prices + ' に ' + (rows.length - 1) + ' 行を書き込みました。');
}

/**
 * GitHub Contents API でファイルを1つ取得する。
 * private リポジトリの場合は Contents: Read-only の fine-grained PAT が要る。
 */
function fetchGitHubFile_(repo, path, ref) {
  var url =
    'https://api.github.com/repos/' + repo + '/contents/' + encodeURI(path) + '?ref=' + encodeURIComponent(ref);

  var headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  var token = PropertiesService.getScriptProperties().getProperty(PROP.token);
  if (token) headers.Authorization = 'Bearer ' + token;

  var response = UrlFetchApp.fetch(url, {
    headers: headers,
    muteHttpExceptions: true,
    followRedirects: true,
  });

  var status = response.getResponseCode();
  if (status === 404) {
    throw new Error(
      'ファイルが見つかりません (404): ' + path + '\n' +
        'リポジトリ名・ブランチ名と、トークンに Contents: Read-only の権限があるかを確認してください。',
    );
  }
  if (status === 401 || status === 403) {
    throw new Error('GitHubの認証に失敗しました (' + status + ')。トークンの有効期限と権限を確認してください。');
  }
  if (status !== 200) {
    throw new Error('GitHub APIがエラーを返しました (' + status + '): ' + response.getContentText().slice(0, 200));
  }

  var body = JSON.parse(response.getContentText());
  if (!body.content) {
    throw new Error('APIの応答にファイル内容が含まれていません: ' + path);
  }

  // content は base64。UTF-8として復元する（日本語が含まれるので必須）。
  var bytes = Utilities.base64Decode(body.content.replace(/\n/g, ''));
  return { content: Utilities.newBlob(bytes).getDataAsString('UTF-8'), sha: body.sha };
}

/** BOM を落としてから CSV を配列に変換する。 */
function parseCsv_(text) {
  return Utilities.parseCsv(text.replace(/^﻿/, ''));
}

/** 認可一覧タブの内容を組み立てる。 */
function approvalRows_(approvals, priceRows) {
  var header = priceRows[0];
  var pdfColumn = header.indexOf('出典PDF');

  var counts = {};
  if (pdfColumn >= 0) {
    for (var i = 1; i < priceRows.length; i++) {
      var url = priceRows[i][pdfColumn];
      counts[url] = (counts[url] || 0) + 1;
    }
  }

  var rows = [['認可年月日', '認可年月日_和暦', '区分', '件名', '抽出件数', '出典PDF']];
  for (var j = 0; j < approvals.length; j++) {
    var a = approvals[j];
    rows.push([
      a.approvalDate || '',
      a.approvalDateWareki || '',
      a.approvalType || '',
      a.title || '',
      counts[a.pdfUrl] || 0,
      a.pdfUrl || '',
    ]);
  }
  return rows;
}

function readmeRows_(recordCount, approvalCount, repo) {
  var updatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd HH:mm:ss 'JST'");
  return [
    ['製造たばこ小売定価（認可分）統合データ'],
    [''],
    ['最終更新', updatedAt],
    ['収録レコード数', recordCount],
    ['収録認可件数', approvalCount],
    [''],
    ['出典', '財務省「製造たばこの小売定価の認可」'],
    ['出典URL', SOURCE_URL],
    ['生成元', repo],
    [''],
    ['このシートについて'],
    ['財務省が個別のPDFで公表している認可済みの製造たばこ小売定価を、機械的に読み取って1つの表にまとめたものです。'],
    ['財務省が作成・公表しているものではなく、非公式の二次データです。'],
    [''],
    ['免責'],
    ['PDFからの自動抽出のため、誤り・取りこぼし・重複が含まれる可能性があります。正確な内容は必ず出典PDFで確認してください。'],
    ['各行の「出典PDF」列から、元の認可PDFに直接あたれます。'],
    ['「抽出精度」列が「中」の行は、表の列構造を検出できずに推定で読み取った行です。'],
    [''],
    ['更新の仕組み'],
    ['1日1回、出典ページを巡回して新しい認可PDFを検出し、追加分だけを解析してこの表に反映します。'],
    ['過去分を含めて毎回全体を書き換えるため、同じ内容で何度実行しても結果は変わりません。'],
    [''],
    ['利用について'],
    [
      '出典である財務省ウェブサイトのコンテンツは政府標準利用規約に基づき利用しています。' +
        '二次データである本シートも同様に自由にご利用いただけますが、出典として財務省の当該ページを併記してください。',
    ],
  ];
}

/** タブを作り直して values を書き込む。行数が多い場合は分割して書く。 */
function writeTab_(spreadsheet, title, rows) {
  var sheet = spreadsheet.getSheetByName(title);
  if (!sheet) sheet = spreadsheet.insertSheet(title);

  var columnCount = 1;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].length > columnCount) columnCount = rows[i].length;
  }

  // 行ごとの列数を揃える（setValues は矩形しか受け付けない）
  for (var j = 0; j < rows.length; j++) {
    while (rows[j].length < columnCount) rows[j].push('');
  }

  // 行数を変える前に既存のフィルタを外す（範囲が残っていると後の操作が失敗しうる）
  var existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();

  sheet.clear();
  resizeGrid_(sheet, rows.length, columnCount);

  for (var offset = 0; offset < rows.length; offset += CHUNK_ROWS) {
    var chunk = rows.slice(offset, offset + CHUNK_ROWS);
    sheet.getRange(offset + 1, 1, chunk.length, columnCount).setValues(chunk);
  }
}

/** setValues できるようにグリッドの行数・列数を必要なだけ確保する。 */
function resizeGrid_(sheet, rowCount, columnCount) {
  var maxRows = sheet.getMaxRows();
  if (maxRows < rowCount) sheet.insertRowsAfter(maxRows, rowCount - maxRows);
  else if (maxRows > rowCount && maxRows > 1) sheet.deleteRows(rowCount + 1, maxRows - rowCount);

  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < columnCount) sheet.insertColumnsAfter(maxColumns, columnCount - maxColumns);
  else if (maxColumns > columnCount && maxColumns > 1) sheet.deleteColumns(columnCount + 1, maxColumns - columnCount);
}

/** ヘッダ固定・太字・フィルタ。 */
function formatTab_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return;

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#eef2fa');

  var filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).createFilter();
}

/**
 * 新規スプレッドシートに最初からある空タブを片付ける。
 * 既定名かつ中身が空のものだけを対象にする。
 */
function removeEmptyDefaultTab_(spreadsheet) {
  var sheets = spreadsheet.getSheets();
  if (sheets.length <= 1) return;

  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (name !== 'シート1' && name !== 'Sheet1') continue;
    if (sheets[i].getLastRow() > 0 || sheets[i].getLastColumn() > 0) continue;
    spreadsheet.deleteSheet(sheets[i]);
    return;
  }
}

function required_(props, key) {
  var value = props.getProperty(key);
  if (!value) {
    throw new Error('スクリプトプロパティ ' + key + ' が未設定です。apps-script/README.md を参照してください。');
  }
  return value;
}

function log_(message) {
  Logger.log(message);
}
