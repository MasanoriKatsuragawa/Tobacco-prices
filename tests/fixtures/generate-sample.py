"""テスト用の疑似「認可PDF」を生成する。

sample-approval.pdf は財務省の実PDFではなく、同じ体裁を模して作った合成データ。
日本語CIDフォント（UniJIS-UCS2-H）を使うので、pdfjs の CMap 設定が壊れると
テストが落ちる ── そこがこのフィクスチャの主目的。

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

ROWS = [
    ("メビウス", "20本", "600", "令和8年8月1日"),
    ("メビウス・ワン", "20本", "600", "令和8年8月1日"),
    ("セブンスター", "20本", "660", "令和8年8月1日"),
    ("わかば", "20本", "520", "令和8年8月1日"),
]


def main() -> None:
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))
    c = canvas.Canvas(str(OUT), pagesize=(595, 842))

    c.setFont(FONT, 11)
    c.drawString(50, 780, "製造たばこの小売定価の認可について")
    c.drawString(50, 760, "実施日 令和8年8月1日")

    c.setFont(FONT, 10)
    c.drawString(50, 720, "日本たばこ産業株式会社")

    c.drawString(50, 700, "銘柄")
    c.drawString(250, 700, "内容量")
    c.drawString(350, 700, "小売定価")
    c.drawString(460, 700, "実施日")

    y = 680
    for name, qty, price, date in ROWS:
        c.drawString(50, y, name)
        c.drawString(250, y, qty)
        c.drawString(350, y, price)
        c.drawString(460, y, date)
        y -= 20

    c.drawString(50, y - 20, "（注）上記は認可された小売定価である。")
    c.showPage()
    c.save()
    print(f"written {OUT}")


if __name__ == "__main__":
    main()
