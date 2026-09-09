# @dshserver/dsh-deliverables

托管部署里,让对话中的产物**点开就能在右侧栏里看**。

## 解决什么

DSH 的产物徽章、正文里的文件提及、工具行,打开文件最终都要落到宿主机上:把路径交给
**那台机器**的系统默认程序。浏览器和宿主机是同一台机器时这是对的;托管部署里不是:
那台服务器没有桌面,也没有人坐在它前面。于是用户被告知"产出了 article.html",点下去
只能得到一个自己无能为力的拒绝。

这个插件在浏览器侧给出另一个去处:产出文件在**右侧栏**里打开。

## 组进 profile

```yaml
- id: dshserver-deliverables
  name: '@dshserver/dsh-deliverables'
```

**这只做完了一半。** 这个插件让产出文件在浏览器里可看,但它关不掉宿主机那个出口——
那需要两处配合,缺一处等于没做:

```yaml
# 一、profile:不给用户「用本机程序打开」这个入口
- id: open-in-app
  disabled: true

- id: ui-open-in-app
  disabled: true

# `nativeOpen` 的强度两个控制器不一样:settings-controller 的 `openDocument` 会先查
# `canOpenPath()`,这里是真拒绝;session-controller 的 `openWorkspacePath` 不查它,
# 所以那条**只是 UI 提示**。
- id: session-controller
  config:
    nativeOpen: false

- id: settings-controller
  config:
    nativeOpen: false
```

二、**网关必须拒绝 `session.openWorkspacePath`**。这才是真正的边界:那个 RPC 会在
Runtime 宿主机上执行 `open`/`xdg-open`,而上面的 `nativeOpen: false` 拦不住直接发来的
请求。用 `@dshserver/runtime-gateway` 的话它已经在默认黑名单里;自己实现网关的部署
必须自行加上。

## 按类型怎么展示

这个插件只认领内置文本预览显示不了的那几类,其余**故意**不认领:

| 类型 | 展示 | 谁来显示 |
|---|---|---|
| HTML | 沙箱 iframe | 本插件 |
| 图片 | 内联 | 本插件 |
| PDF / Office | 不预览,给下载 | 本插件 |
| Markdown / 文本 / 代码 / JSON | 分页文本 | DSH 内置的 `ui-sidebar-textpreview` |

内置预览会分页读、能跳行、能重载,本插件没有理由再画一个更差的,所以这些类型是**故意**
不认领的,不是遗漏。

### HTML 的沙箱档位

`sandbox="allow-scripts"`,**不给** `allow-same-origin`,而且两者永不同时给 ——
同时给的话文档可以自己摘掉 sandbox 属性,约束就成了装饰。只给 `allow-scripts`,
文件拿到一个不透明来源:脚本照常运行(产出的页面、小游戏能用),而会话 Cookie、
`/api` 接口和承载它的这个文档都够不到。产物是模型写的,这个理由就够了。

## 怎么抢到这几类文件

右侧栏有一份 tab 类型注册表,而且是**为产品外部的类型准备的**:类型按
glob 认领资源地址,按档位排序,`extension` 档在 `builtin` 和 `fallback` 之上。内置文本
预览自己蹲在 `fallback`,并在注释里写明"任何更具体的类型都该赢过它"。

所以本插件的定义**不写 `priority`** —— 注册表对没表态的类型默认就是 `extension`,那也是
一个来自产品外部的类型该在的位置。认领范围见上表,`canOpen` 再否掉 `absolute` 作用域的
地址(那种地址不属于任何会话工作区,本插件的路由服务不了,交回内置预览才是能看的)。

## 两条约束

**文件路由是路径式的,不是查询式的。** 产出的 `article.html` 用相对路径引用配图,
而相对引用是相对文档自身 URL 解析的。`…/file?path=article.html` 之下,`cover.png`
会解析到一个本路由不提供的地址,预览出来满屏裂图。

**收敛在 realpath 之后比较。** 请求给的是会话与工作区相对路径,返回的必须在那个
工作区之内:不是隔壁 Subject 的,不是 `/etc`,也不是一条指向外面的符号链接。
(路径里的 `..` 其实到不了这里 —— URL 解析在规范化 pathname 时就去掉了,`%2e%2e`
同样,因为 URL 标准把 `%2e` 视同 `.`。收敛守的是符号链接与绝对路径。)

## 浏览器半边自带地址解析

`parseSessionFileAddress` 是 DSH `parseFileAddress` 的一份**有意的本地副本**。这个包以
符号链接进 profile,身边没有自己的 `node_modules`,所以浏览器半边运行时除了 React
什么都不能 import —— `tests/bundle.spec.ts` 守着这条线,而它已经被破过两次。
