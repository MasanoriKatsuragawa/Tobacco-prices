# Apps Script 方式（Google Cloud を使わない同期）

組織のポリシーでサービスアカウント鍵の作成が禁止されている場合、
あるいは Google Cloud のプロジェクト自体を使えない場合の取り込み方法です。

## 仕組み

```
GitHub Actions           財務省サイトを巡回 → PDF解析 → CSV生成 → リポジトリにコミット
   （Google認証は一切なし）
        │
        │  Apps Script が1日1回、GitHub API で CSV を取りに行く
        ▼
Apps Script              シートの所有者（あなた）の権限で実行される
   （Google Cloud なし）   → スプレッドシートに書き込む
```

**Googleの認証情報を作りません。** スクリプトはシートの所有者として動くため、
サービスアカウントも鍵もWorkload Identity連携も不要です。
外に出す資格情報は GitHub の読み取り専用トークン1つだけで、それもあなたの
Apps Script プロジェクト内（スクリプトプロパティ）に置かれます。

なおスクリプトが要求する Google の権限は、`spreadsheets.currentonly`
（このスプレッドシートのみ）・トリガー作成・外部通信の3つだけです。
Drive全体へのアクセス権は要求しません。

## セットアップ

### 1. GitHub の読み取りトークンを作る

リポジトリが private なので、読み取り専用のトークンが必要です。
（リポジトリを public にする場合、この手順は丸ごと不要です）

1. GitHub の Settings > Developer settings > **Personal access tokens > Fine-grained tokens**
2. **Generate new token**
   - Repository access: **Only select repositories** → `Tobacco-prices` だけを選ぶ
   - Permissions > Repository permissions > **Contents: Read-only**
     （他の権限は付けないこと）
   - Expiration: 運用に合わせて設定（期限切れで同期が止まるので、更新日をカレンダーに入れておく）
3. 生成されたトークンを控える

### 2. スクリプトを貼る

1. スプレッドシートを開く →
   [製造たばこ小売定価（認可分）統合データ](https://docs.google.com/spreadsheets/d/1IuCoK0oWY5HQ5uRDiLQVI4kSxeu_hpLX95JxCYfzNOo/edit)
2. メニューの **拡張機能 > Apps Script**
3. 既定の `コード.gs` の中身を、このディレクトリの [`Code.gs`](Code.gs) の内容で置き換えて保存

このディレクトリの [`appsscript.json`](appsscript.json) は、要求するGoogle権限を
「このスプレッドシートのみ・トリガー作成・外部通信」の3つに絞るためのマニフェストです。
**貼らなくても動きます**（その場合Apps Scriptが必要な権限を自動で判断します）。
最小権限にしたい場合のみ、「プロジェクトの設定 > `appsscript.json` マニフェスト
ファイルをエディタで表示する」を有効にして内容を置き換えてください。
もしトリガー実行時に権限エラーが出るようなら、`spreadsheets.currentonly` を
`https://www.googleapis.com/auth/spreadsheets` に変えると解消します。

### 3. スクリプトプロパティを設定する

Apps Script エディタの左メニュー **プロジェクトの設定** > **スクリプト プロパティ** で追加します。

| プロパティ | 値 |
| --- | --- |
| `GITHUB_REPO` | `MasanoriKatsuragawa/Tobacco-prices` |
| `GITHUB_REF` | 取り込むブランチ名（通常は `main`） |
| `GITHUB_TOKEN` | 手順1のトークン（public リポジトリなら不要） |

> `LAST_SYNCED_SHA` はスクリプトが自動で書き込みます。手動で設定しないでください。

### 4. 動作確認と自動化

1. エディタ上部の関数選択で `updateFromGitHub` を選び、**実行**
   - 初回は権限の承認を求められるので許可する
   - 「このアプリは確認されていません」と出た場合は、自分で作ったスクリプトなので
     詳細を開いて続行してよい
2. シートに「定価一覧」「認可一覧」「このシートについて」が作られることを確認
3. 問題なければ `installDailyTrigger` を実行 → 毎日 07:00 JST に自動更新される
   （GitHub Actions が 06:15 JST に動くので、その後に取りに行く順番）

以降はスプレッドシートのメニューに「データ更新」が追加され、
手動での取り込みやトリガー設定はそこからも実行できます。

## 挙動

- CSVのblob SHAを記録しており、**前回から変わっていなければ書き込みません**。
- 取得したCSVが空、またはヘッダしか無い場合は**中断します**（空データでの上書き防止）。
- 「認可一覧」の取得に失敗しても「定価一覧」の更新は続行します。
- 毎回タブ全体を書き換えるため、何度実行しても結果は同じです（冪等）。

## うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| `ファイルが見つかりません (404)` | `GITHUB_REPO` / `GITHUB_REF` の綴り、またはトークンの Contents 権限を確認。まだ該当ブランチにCSVがコミットされていない可能性もある |
| `GitHubの認証に失敗しました (401/403)` | トークンの有効期限切れ。作り直してプロパティを更新する |
| `CSVに行がありません` | GitHub Actions 側がまだ1度も成功していない。Actions の実行結果を確認する |
| 実行時間が6分を超える | データが増えた場合。`CHUNK_ROWS` を小さくするか、Actions 側で列を絞る |
| 日本語が文字化けする | `Code.gs` を改変した場合のみ発生しうる。base64復号後に `getDataAsString('UTF-8')` を通していることを確認 |

## 公開設定

同期とは別に、シート側で共有設定を行ってください。

- 「共有」→「一般的なアクセス」を **リンクを知っている全員** ＋ **閲覧者**
- 編集者として追加するアカウントは作りません（このスクリプトはあなたの権限で動くため）
