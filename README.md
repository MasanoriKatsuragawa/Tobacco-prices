# 製造たばこ小売定価（認可分）統合データ

財務省が[「製造たばこの小売定価の認可」](https://www.mof.go.jp/policy/tab_salt/topics/kouriteika.html)のページで
**認可ごとに個別のPDF**として公表している小売定価を、機械的に読み取って
**1つの表（Googleスプレッドシート／CSV）**に統合し、以後は自動で追記していくためのツールです。

- 出典ページ: https://www.mof.go.jp/policy/tab_salt/topics/kouriteika.html
- 生成物（このリポジトリ内）: [`data/tobacco-retail-prices.csv`](data/tobacco-retail-prices.csv)
- 公開先: Googleスプレッドシート（一般公開・閲覧のみ）

---

## 1. できること

| コマンド | 内容 |
| --- | --- |
| `npm run update` | 出典ページを巡回 → 新しい認可PDFだけ取得 → 解析 → `data/` を更新 |
| `npm run sync` | `data/` の内容をGoogleスプレッドシートへ反映 |
| `npm run crawl` | 認可PDFの一覧だけを更新（中身は取りに行かない） |
| `npm run inspect -- <URL または パス>` | PDFがどう読めているかを座標付きで表示（パーサ調整用） |
| `npm test` | ユニットテスト＋実PDFの通しテスト |

主なオプション:

- `--full` … 既知のPDFも取り直して全件を再解析する（パーサを直したときに使う）
- `--limit=N` … 1回に新規取得するPDFの上限（既定 400）
- `--force` … データに変化が無くてもスプレッドシートへ書き込む（`sync`）

## 2. 出力されるデータ

`data/tobacco-retail-prices.csv` と スプレッドシートの「定価一覧」タブは同じ内容です。

| 列 | 説明 |
| --- | --- |
| `id` | 行の安定ID（出典PDF・ページ・銘柄・定価・内容量から導出）。再実行しても変わらない |
| `認可年月日` / `認可年月日_和暦` | 認可日。ISO形式と和暦の両方 |
| `区分` | 認可 / 変更認可 / 取消 |
| `銘柄` / `銘柄_正規化` | 銘柄名。正規化列は全角半角・中黒・空白を潰した突き合わせ用キー |
| `内容量` / `単位` | 20本、50g など |
| `小売定価_円` | 認可された定価 |
| `改定前定価_円` | 変更認可で現行定価が併記されている場合のみ |
| `実施日` | 定価の実施日。行に無ければ文書全体の実施日を採用 |
| `製造者_輸入者` | 表中または直前の見出しから拾った社名 |
| `出典PDF` / `出典ページ` | 元の認可PDFのURLとページ番号。**必ず一次情報に戻れるようにしてある** |
| `抽出精度` | `高`=表のヘッダから列を検出できた / `中`=1行から推定した |

補助ファイル:

- `data/approvals.json` … 認可PDFの一覧（日付・区分・URL）
- `data/records.json` … 定価レコードのマスタ（`原文`列を含む）
- `data/unparsed.json` … 表の行に見えたのに解釈できなかった行。**パーサ改善のためのTODOリスト**
- `data/state.json` … PDFごとのETag / Last-Modified / SHA-256。差分取得に使う

## 3. インターネット公開を前提とした設計

このデータは公開前提で作っています。設計上そうしている点を明示しておきます。

**中身**

- 収録するのは財務省が公表済みの公開情報のみ。個人情報・非公開情報は一切扱いません。
- 全行に `出典PDF` を付け、必ず一次情報に戻れるようにしています。二次データ単体で完結させません。
- 自動抽出である以上、誤り・取りこぼしはあり得ます。スプレッドシートの「このシートについて」タブに
  **非公式である旨・免責・出典**を常時掲示し、更新日時とレコード数を毎回書き換えます。
- 読み取りに自信がない行は削除せず `抽出精度=中` として残し、判断材料を利用者に渡します。

**権限**

- スプレッドシートの所有者は人間（あなたのGoogleアカウント）。一般公開は**閲覧者まで**。
- 書き込めるのは1主体だけ。既定の Apps Script 方式ではそれが**あなた自身**なので、
  Googleの資格情報を新たに1つも作りません（4.2 参照）。
- Google Cloud を使う場合も、渡すのは**そのシート1枚の編集権限**だけです（Drive全体の権限は渡さない）。
  可能なかぎり鍵ファイルを作らない Workload Identity 連携を選びます。
- 同期は追記ではなく毎回全書き換え（冪等）。壊れた場合も `--full` で作り直せます。
- 空のCSVや取得失敗でシートを上書きしないよう、書き込み前に件数を検査して中断します。

**巡回のマナー**

- 逐次アクセス・リクエスト間 1.5 秒待機・連絡先入りUser-Agent。
- ETag / Last-Modified による条件付きGETと、取得済みPDFのキャッシュで再ダウンロードを避けます。
  定常運用では1日あたり数リクエストで済みます。

**出典表記**

> 出典: 財務省「製造たばこの小売定価の認可」
> https://www.mof.go.jp/policy/tab_salt/topics/kouriteika.html
> （本データは上記PDFを機械的に統合した非公式の二次データです）

## 4. セットアップ

### 4.1 スプレッドシートを用意する

公開先のスプレッドシートは作成済みです。

- 名前: 製造たばこ小売定価（認可分）統合データ
- ID: `1IuCoK0oWY5HQ5uRDiLQVI4kSxeu_hpLX95JxCYfzNOo`
- URL: https://docs.google.com/spreadsheets/d/1IuCoK0oWY5HQ5uRDiLQVI4kSxeu_hpLX95JxCYfzNOo/edit

初回同期が終わるまで中身は空です。同期時に「定価一覧」「認可一覧」「このシートについて」の
3タブが作られ、最初からある空の「シート1」は自動で削除されます。

別のシートを使う場合は、Googleドライブで空のスプレッドシートを作り、
URL の `https://docs.google.com/spreadsheets/d/`**`<ここがID>`**`/edit` からIDを控えてください。

### 4.2 シートへの書き込み方式を選ぶ

**サービスアカウントの鍵JSONは、多くの組織でポリシーにより作成が禁止されています**
（`constraints/iam.disableServiceAccountKeyCreation`）。長期間有効な認証情報がファイルとして
出回るのを避けるためで、禁止されているなら鍵を使わない方式を選んでください。

| 方式 | Google Cloud | 長期の資格情報 | 向いている場合 |
| --- | --- | --- | --- |
| **A. Apps Script**（既定） | 不要 | Googleの資格情報なし | GCPを使えない／使いたくない。**まずこれを試す** |
| B. Workload Identity 連携 | 必要 | なし（OIDC） | GCPを使えて、Actions側で完結させたい |
| C. サービスアカウント鍵 | 必要 | 鍵JSON | 上2つが使えない場合の最終手段 |

#### A. Apps Script 方式（Google Cloud 不要・既定）

スプレッドシート側に置いたスクリプトが、1日1回GitHubからCSVを取りに来ます。
**Googleの認証情報を1つも作りません**（スクリプトはシート所有者の権限で動くため）。
GitHub Actions 側にGoogle関連のSecretは不要です。

手順は [`apps-script/README.md`](apps-script/README.md) を参照してください。

#### B. Workload Identity 連携（鍵なし）

GitHub Actions の OIDC トークンでサービスアカウントを借用します。鍵ファイルは作りません。

1. Google Cloud で **Sheets API** を有効化し、サービスアカウントを1つ作る（鍵は作らない）。
2. Workload Identity プールとプロバイダを作り、GitHubのOIDC発行者を登録する。
3. そのサービスアカウントに、GitHubのプリンシパルから
   `roles/iam.workloadIdentityUser` を付与する。
4. 4.1 のスプレッドシートを、サービスアカウントのメールアドレス
   （`...@....iam.gserviceaccount.com`）に**編集者**として共有する。
5. ワークフローの認証ステップを有効にする（`.github/workflows/update.yml` の
   「Google認証（Workload Identity 連携）」のコメントを参照）。
6. Secrets に `GCP_WORKLOAD_IDENTITY_PROVIDER` と `GCP_SERVICE_ACCOUNT` を登録する。

`sync` は鍵が無ければ ADC（Application Default Credentials）を自動で使うので、
コード側の変更は要りません。

#### C. サービスアカウント鍵（組織で禁止されていない場合のみ）

1. Google Cloud で **Sheets API** を有効化し、サービスアカウントを作ってJSON鍵を発行する。
2. 4.1 のスプレッドシートを、そのアドレスに**編集者**として共有する。
3. Secrets に `GOOGLE_SERVICE_ACCOUNT_JSON` として鍵の中身を登録する（base64でも可）。

### 4.3 一般公開の設定

スプレッドシートの「共有」から:

- 「一般的なアクセス」を **リンクを知っている全員** ＋ 権限は **閲覧者**
- 「ファイル > 共有 > ウェブに公開」でも公開でき、こちらは埋め込み用URLやCSV/TSV形式での配布ができます。

> 共有相手の権限を「編集者」にしないこと。編集権限を持つのは同期を行う1主体だけにします。
> A方式ではそれがあなた自身なので、追加で編集者を作る必要はありません。

### 4.4 GitHub Secrets

リポジトリの Settings > Secrets and variables > Actions に登録します。
**A方式（Apps Script）を使う場合、ここでの登録は何も要りません。**

| Secret | 必要な方式 | 値 |
| --- | --- | --- |
| `SPREADSHEET_ID` | B / C | 4.1 で控えたID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | B | `projects/…/locations/global/workloadIdentityPools/…/providers/…` |
| `GCP_SERVICE_ACCOUNT` | B | 借用するサービスアカウントのメールアドレス |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | C | 鍵JSONの中身（base64でも可） |

`SPREADSHEET_ID` が未設定の場合、ワークフローは取得・解析だけ行い、同期はスキップします。
A方式ではこれが正しい状態です（書き込みはApps Script側の担当）。

### 4.5 初回の全件取り込み

初回だけ過去分をまとめて取り込みます。

GitHub Actions の Actions タブで「たばこ小売定価データの更新」を選び、
**Run workflow** の `full` にチェックを入れて実行してください。
完了すると `data/` に結果がコミットされます。

A方式の場合は、そのあとApps Scriptの `updateFromGitHub` を1度手動実行すればシートに反映されます。

ローカルで動かす場合:

```bash
npm ci
npm run update -- --full          # 全PDFを取得して解析（件数によっては数十分かかります）

# B/C方式でシートまで書きたい場合のみ
SPREADSHEET_ID=xxx npm run sync
```

## 5. 自動更新の仕組み

`.github/workflows/update.yml` が担当します。

- **毎日 06:15 JST** に起動（`workflow_dispatch` で手動実行も可）
- 出典ページを条件付きGETで確認 → 未取得のPDFだけダウンロード → 解析
- `data/` に変化があればリポジトリへコミット（差分がそのまま更新履歴になります）
- スプレッドシートへ同期（内容が変わっていなければAPIを叩かずスキップ）
- 解析できなかった行は `unparsed.json` としてアーティファクトに残す
- PR時とpush時はテストのみ実行し、データは更新しません

## 6. 解析がずれたときの直し方

財務省PDFのレイアウトは回によって揺れます。取りこぼしに気づいたら:

```bash
# 1. まず実際のPDFがどう読めているか見る
npm run inspect -- https://www.mof.go.jp/policy/tab_salt/topics/xxxx.pdf

# 2. data/unparsed.json で「表の行に見えたのに落ちた行」を確認する

# 3. src/parse-approval.ts のヘッダ判定・列パターンを直す
#    HEADER_PATTERNS に列名の表記ゆれを足すだけで済むことが多い

# 4. テストを足してから全件を再解析する
npm test
npm run update -- --full
```

レコードのIDは内容から決まるので、再解析しても既存行は重複せず、直った行だけが差し替わります。

## 7. 制約・既知の限界

- **画像PDF（スキャン）は読めません。** テキストが取れないPDFは `needsOcr` として記録し、
  ログに出したうえでスキップします。OCRは入れていません。
- 表のレイアウトが大きく変わった場合、`抽出精度=中` の行が増えます。数が増えたら 6章の手順で調整してください。
- 銘柄名の表記ゆれ（全角半角・中黒）は `銘柄_正規化` で吸収していますが、
  同一商品の名寄せ（改称・リニューアル）まではやっていません。
- インデックスページからPDFリンクを1件も抽出できなかった場合は、ページ構造の変更とみなして
  **エラーで停止**します（空データでスプレッドシートを上書きしないため）。

## 8. ライセンス・利用について

出典である財務省ウェブサイトのコンテンツは
[政府標準利用規約](https://www.mof.go.jp/index.htm)に基づいて利用しています。
本ツールが生成する二次データも同様に自由に利用できますが、利用の際は出典として
財務省の当該ページを併記してください。**本データは財務省が作成・公表したものではありません。**
