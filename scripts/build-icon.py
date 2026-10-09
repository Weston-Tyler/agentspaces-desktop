"""Build the committed desktop icon; requires Pillow only at build time."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
scale = 4
image = Image.new("RGBA", (256 * scale, 256 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle(tuple(v * scale for v in (8, 8, 248, 248)), radius=52 * scale, fill="#111c30")
for x, y in ((53, 87), (65, 132), (53, 181)):
    draw.polygon([(x * scale, y * scale), ((x + 139) * scale, (y - 39) * scale), ((x + 147) * scale, (y - 13) * scale), ((x + 8) * scale, (y + 26) * scale)], fill="#83a5ff")
image = image.resize((256, 256), Image.Resampling.LANCZOS)
image.save(root / "assets" / "agentspaces.png")
image.save(root / "assets" / "agentspaces.ico", sizes=[(v, v) for v in (16, 24, 32, 48, 64, 128, 256)])
print("AgentSpaces desktop icon built.")
