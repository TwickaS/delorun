---
kind: upgrade-guide
description: "通过明文 HTTP 发往非 loopback authority 的改变状态的 /api 请求必须说明来源。"
---

# 通过明文 HTTP 改变状态的 `/api` 请求需说明来源

[English](guide.md) | 中文

## 变更

`dsh-client-connection` 在请求到达 `/api` 之前多检查一条规则。改变状态的请求，即 `GET`、`HEAD`、`OPTIONS` 以外的任何方法，必须说明来源：带有指向监听器自身 authority 的 `Origin` header，或 `Sec-Fetch-Site: same-origin` 或 `none`。`Sec-Fetch-Site: same-site` 与 `cross-origin` 以 403 拒绝。

既不带 `Origin` 也不带 `Sec-Fetch-Site` 的请求，发往 loopback `Host`（`127.0.0.1`、`localhost`、`[::1]`）或 HTTPS 监听器时仍然放行，因为每个发送 Fetch-Metadata 的浏览器都会对这些目标附带它。通过明文 HTTP 发往其他 authority 时，例如 `trustedHosts` 中的名称或局域网上监听器的绑定地址，这类请求以 403 拒绝：浏览器对这些目标不附带标记，带 `Referrer-Policy: no-referrer` 的表单提交也不附带 `Origin`，因此无法与外部页面发出的请求区分。

请求目标按路由同样的方式读取，即经过 WHATWG URL 归一化，因此 `/x/../api/...` 及其百分号编码写法适用同一规则。每个监听器都以 400 回应带有多个 `Host` 行的请求。

受影响的是通过明文 HTTP 在非 loopback 地址上以 `POST` 或其他改变状态的方法调用 Web 监听器 `/api` 的脚本、SDK 客户端和代理。浏览器、同一台机器上的调用方和 HTTPS 监听器不受影响。

## 迁移

1. 在调用非 loopback 地址上明文 HTTP 监听器的客户端中发送 `Origin`，其 scheme 与 authority 与 `Host` header 所写完全一致，例如 `Origin: http://192.0.2.5:3080`。
2. 也可以通过 webserver 的 `tls` 配置以 HTTPS 提供该监听器，或通过 loopback 端口转发访问，例如 `ssh -L 3080:127.0.0.1:3080`。
3. 只发送一个 `Host` header。
4. 重复该调用以确认：原先的 403 变为路由自身的回应，例如 200 或 401。
