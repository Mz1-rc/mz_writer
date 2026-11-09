# mz_writer

Pi 多 Agent 协作写作团队。

- 方案设计：[design.md](./design.md)
- 扩展实现：[.pi/extensions/writing-team/](./.pi/extensions/writing-team/)
- 扩展说明：[.pi/extensions/writing-team/README.md](./.pi/extensions/writing-team/README.md)

## 快速开始

```bash
cd /path/to/mz_writer
pi
```

在 Pi 中：

```text
/book init 长夜将明
/book next
```

之后按闸门提示使用 `/book approve`、`/book revise <意见>`、`/book next` 推进。

## 测试

```bash
cd .pi/extensions/writing-team
node --experimental-strip-types --test tests/*.test.ts
```

书籍工件默认写入 `books/<slug>/`，导出成稿在 `books/<slug>/exports/latest.md`。
