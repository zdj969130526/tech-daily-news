# tech-daily-news
Xiaoyi Claw Newbee！

## 本地预览：酷安新品日历

预览版支持从本机酷安 App 的只读缓存导入两个结构化板块：

- 数码 → 上市新品
- 数码 → 发布日历

先在酷安中分别打开两个列表并向下滚动，让 App 刷新本地缓存，然后执行：

```bash
python3 ../热点看板/coolapk_release_calendar.py
```

脚本只更新本目录的 `data.json`，不会修改 `tech-daily-news` 线上仓库，也不会读取或复制酷安账号、Cookie 和请求头。待发布条目会显示在主日历，最近 30 天的上市新品会作为核对区显示。
