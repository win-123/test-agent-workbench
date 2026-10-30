# 第八阶段白盒抽查

## 结论

- 自建 Java 源码 fixture：通过，端点映射、调用参数、分支、异常和行号证据与源码抽查一致。
- 自建 WAR fixture：通过，安全清单、class 方法、字节码分支和参数类型证据可复核。
- 真实业务源码/WAR：未验证，未提供样本。
- runtime coverage：未测量，`percentage=null`。

## 抽查事实

- `GET /api/orders/{id}` -> `OrderController.findOrder`，源码 20-25 行。
- `POST /api/orders` -> `OrderController.createOrder`，源码 28-34 行。
- `findOrder -> service.find`，参数表达式 `id`，源码 25 行。
- `createOrder -> service.submit`，参数表达式 `request`，源码 32/34 行。
- `OrderService.find/submit` 分支与异常具备源码行号。
- WAR 中 `DemoService.choose` 具备字节码 if 分支；`choose -> helper` 参数类型为 `java.lang.String`。
- `LegacyRouter` 使用 Reflection，静态调用链不完整已被明确标记。

## 遗漏/限制

- Java record `OrderRequest` 被标记为未解析方法签名，这是解析器遗漏。
- 异常 message 字符串提取不完整。
- branch id 只在类内唯一，未全局唯一。
- WAR 嵌套 JAR 未内调。
- 未收到真实业务源码或 WAR，不能声称真实业务白盒能力已验收。
