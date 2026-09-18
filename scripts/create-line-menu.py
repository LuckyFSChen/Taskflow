from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

dest=Path(__file__).resolve().parents[1]/'cloud-inbox'/'assets'
dest.mkdir(exist_ok=True)
im=Image.new('RGB',(2500,843),'#122b39')
d=ImageDraw.Draw(im)
font=ImageFont.truetype('C:/Windows/Fonts/msjh.ttc',74)
small=ImageFont.truetype('C:/Windows/Fonts/msjh.ttc',34)
number=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',42)
items=[('發布任務','選擇專案，告訴 AI 你的需求'),('任務進度','查看正在執行與已完成的工作'),('待我審核','核准計畫，回答需要確認的問題'),('工作台','查看完整紀錄與成果')]
for i,(title,subtitle) in enumerate(items):
    x=(i%2)*1250;y=0 if i<2 else 421
    d.rounded_rectangle((x+20,y+20,x+1230,y+401),radius=25,fill='#163f47' if i==0 else '#1c3445')
    d.rounded_rectangle((x+75,y+88,x+164,y+177),radius=20,fill='#2ca58e' if i==0 else '#2b4c5d')
    d.text((x+98,y+101),str(i+1).zfill(2),font=number,fill='#ffffff')
    d.text((x+208,y+82),title,font=font,fill='#ffffff')
    d.text((x+210,y+205),subtitle,font=small,fill='#a3c4cd')
im.save(dest/'rich-menu.png',optimize=True)
print('Rich menu PNG created:',(dest/'rich-menu.png').stat().st_size,'bytes')
