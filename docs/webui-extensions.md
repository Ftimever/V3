# WebUI 扩展

第一版提供固定 CSP 的宿主页面、统一管理 API 和声明式贡献 registry。WebUI 与 CLI 不直接操作 loader 私有对象；管理端默认只监听 loopback，并要求 Bearer token。

## 声明式贡献

插件可以声明导航、配置 Schema 及 host 渲染的 status-card、log-panel、info-card。Schema 不接受自定义组件名。第一版不允许替换已有页面，也不加载任意插件前端脚本。

路由、贡献 ID 和资源需要按插件实例命名空间校验；停止插件后撤销贡献。主题可以通过设计 token 与预定义 slot 扩展，不具备任意页面重写权。

## 配置应用

用户点击应用后，管理端校验权限、配置版本和 Schema，并根据字段 reload policy 应用。保存版本与实际运行版本是不同事实；界面必须分别显示已保存、待重启、应用中、应用失败和回滚失败。

密钥仅显示引用与配置状态。未来 HTTP 管理端默认仅监听 loopback，并在开放远程管理前实现认证、授权和 CSRF 防护；不能把服务启动等同于安全可公开部署。
