"""テスト用の疑似「認可PDF」を生成する。

sample-approval.pdf は財務省の実PDFではなく、実物の体裁を模した合成データ。
実PDF 273件を解析して分かった構造をなぞってある:

  - ヘッダが2行にまたがる（「製造たばこの品目」／「名称」など）
  - 製造たばこの区分・製造国・製品の区分・価格が縦方向に結合され、
    範囲の中央に1回だけ描画される
  - 変更認可は「現行小売定価」「変更後小売定価」の2列
  - 実施日は和暦の省略形「8.10.1」

日本語CIDフォント（UniJIS-UCS2-H）を使うので、pdfjs の CMap 設定が壊れると
テストが落ちる ── そこもこのフィクスチャの目的。

再生成:
    pip install reportlab
    python tests/fixtures/generate-sample.py
"""

from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

FONT = "HeiseiKakuGo-W5"
OUT = Path(__file__).with_name("sample-approval.pdf")

# (y, 派生名) — ファミリー名・価格・製造国・製品の区分は結合セル
VARIANTS = [
    (744.8, "･ｱｲｽ"),
    (730.3, "･ﾐｯｸｽ"),
    (711.6, "･ｱｲｽ･ﾌﾟﾗｽ"),
    (693.1, "･ﾍﾞﾙﾍﾞｯﾄ"),
]


def main() -> None:
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))
    c = canvas.Canvas(str(OUT), pagesize=(595, 842))

    # ヘッダ（2行にまたがる）
    c.setFont(FONT, 8)
    c.drawString(170, 763.6, "製造たばこの品目")
    c.drawString(400, 763.6, "製造国")
    c.drawString(425, 763.6, "現　　行")
    c.drawString(461, 763.6, "変　　更")
    c.drawString(502, 763.6, "変更実施")

    c.drawString(55, 754.6, "製造たばこの区分")
    c.drawString(206, 754.6, "名")
    c.drawString(238, 754.6, "称")
    c.drawString(336, 754.6, "製品の区分")
    c.drawString(400, 754.6, "（地）")
    c.drawString(425, 754.6, "小売定価")
    c.drawString(461, 754.6, "小売定価")
    c.drawString(502, 754.6, "年 月 日")

    # 派生名（行の区切りを決める列）
    c.setFont(FONT, 8)
    for y, name in VARIANTS:
        c.drawString(171, y, name)

    # 結合セル（範囲の中央に1回だけ）
    middle = (VARIANTS[0][0] + VARIANTS[-1][0]) / 2
    c.drawString(55, middle, "加熱式たばこ")
    c.drawString(138, middle, "ﾐｯｸｽ")
    c.drawString(335, middle, "F45 20ｽﾃｨｯｸ")
    c.drawString(400, middle, "大韓民国")
    c.drawRightString(462, middle, "560円")
    c.drawRightString(493, middle, "590円")
    c.drawString(502, middle, "8.10.1")

    c.showPage()
    c.save()
    print(f"written {OUT}")


if __name__ == "__main__":
    main()
