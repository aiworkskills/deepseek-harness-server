# @dshserver/dsh-embed-chrome

DSH 嵌在你自己的页面里时，**让那个页面来决定顶上写什么**。

## 解决什么

托管部署里，Runtime 通常显示在部署方自己的页面中——它有自己的导航、自己的账号、
自己对「用户正在做什么」的叫法。DSH 自带的那套 chrome（左边栏品牌、空会话的大标题）
对独立产品是对的，在这个框里是错的：用户明明在**你的**产品里，框里却站着另一个身份。

只有嵌入方知道正确答案，所以由嵌入方给出。不是配置项——页面会改主意（用户改了工作区
名字、切了账号），而这不该要求重启 Runtime。

## 组进 profile

```yaml
- id: dshserver-embed-chrome
  name: '@dshserver/dsh-embed-chrome'
  config:
    hostOrigin: https://app.example.com
```

`hostOrigin` 留空（默认）即关闭：路由照常提供、回答一个空来源，浏览器端把每一处
都留作 DSH 出厂的样子。**没想清楚谁可以给自己的 Runtime 穿衣服的部署，得到的是独立
产品，不是一扇敞开的门。**

## 页面这边写什么

```js
const frame = document.querySelector('iframe')

window.addEventListener('message', event => {
  if (event.origin !== RUNTIME_ORIGIN) return
  if (event.source !== frame.contentWindow) return
  const message = event.data
  if (message?.source !== 'dsh-embed-chrome' || message.version !== 1) return

  if (message.type === 'ready') {
    frame.contentWindow.postMessage({
      source: 'dsh-embed-chrome',
      version: 1,
      type: 'chrome',
      brand: '甲公众号',
      headline: '一条龙写公众号',
      workspaces: [{ id: 'a', name: '甲公众号' }, { id: 'b', name: '乙公众号' }],
      currentWorkspaceId: 'a',
    }, RUNTIME_ORIGIN)
  }

  if (message.type === 'switch') {
    // 换工作区意味着换一个 Runtime、换一张令牌，只有页面能重新签发。
    reloadFrameForWorkspace(message.workspaceId)
  }
})
```

`chrome` 的每个字段都是可选的，**缺席等于「这一处别动」**。只发 `{type:'chrome'}`
什么都不改——这正是让一个只实现了一半的页面依然安全的原因。

`switch` 是**请求，不是命令**。浏览器端不在本地改任何东西：它开口，然后等着被重新加载。

## 三条信任规则

1. **来源由 Host 指定。** 页面在另一个来源上（Runtime 走网关，产品在部署方自己的域名），
   所以"同源"不能作为判据。这个来源只能由运维写进配置。
2. **发送方必须是自己的父窗口。** 只验来源的话，同一来源上的另一个窗口——比如用户被
   导航过去的一个弹窗——也能给这个 Runtime 穿衣服并递上工作区列表。
3. **只往那个来源发，永不用 `'*'`。** 通配目标等于把工作区名单交给任何嵌了我们的人。

## 一处不干净的地方，写在明面上

DSH 把 hero 的**图标**开成了槽位，却把大标题和「预览版」徽章留在组件里当本地化字符串，
而它的本地化注册表**拒绝同一命名空间的第二个所有者**——覆盖 `hero.headline` 会直接抛错，
不会生效。

所以这里用支持的那一半做它能做的（图标槽位承载我们的文案），剩下两个 span 用一条
结构选择器藏掉。规则挂在本包自己设的标记属性上，**绝不挂 DSH 哈希过的 CSS Module 类名**，
因此上游改样式不会悄悄失效；上游若重排 hero，选择器不再命中，原来的标题回来——看得见，
且无害，而不是一个空白的 hero。

## 左边栏顶部那块不是容器

它是**新建会话按钮本身**，而且内容带着 `aria-hidden="true"`。所以放在这里的控件必须
拦住自己的点击（否则顺手开一个新会话），并且读屏用户完全够不到它——`aria-hidden` 对整棵
子树生效，后代改不回来。

需要切换器对读屏可用的部署，应当把它放进 `sidebar.footer.action`，那是一个普通区域。
本包仍然占这个位置，是因为「当前在哪个工作区」在视觉上就该在最上面。
