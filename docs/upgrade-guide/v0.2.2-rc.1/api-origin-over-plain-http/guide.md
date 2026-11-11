---
kind: upgrade-guide
description: "A state-changing /api request over plain HTTP to a non-loopback authority must state its origin."
---

# State-changing `/api` requests over plain HTTP state their origin

English | [中文](guide.zh.md)

## Change

`dsh-client-connection` checks one more rule before a request reaches `/api`. A state-changing request, any method other than `GET`, `HEAD` and `OPTIONS`, must state where it came from: an `Origin` header naming the listener's own authority, or `Sec-Fetch-Site: same-origin` or `none`. `Sec-Fetch-Site: same-site` and `cross-origin` are refused with 403.

A request that carries neither `Origin` nor `Sec-Fetch-Site` still passes toward a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`) and toward an HTTPS listener, where every browser that sends Fetch-Metadata attaches it. Toward any other authority over plain HTTP, such as a `trustedHosts` name or the listener's bind address on a local network, it is refused with 403: a browser withholds the markers there, and a form post with `Referrer-Policy: no-referrer` withholds `Origin` as well, so the request cannot be told apart from one a foreign page sent.

The target is read as the router reads it, after WHATWG URL normalization, so `/x/../api/...` and its percent-encoded spellings are held to the same rule. Every listener answers a request with more than one `Host` line 400.

This affects scripts, SDK clients and proxies that call a Web listener's `/api` with `POST` or another state-changing method over plain HTTP at a non-loopback address. Browsers, same-machine callers and HTTPS listeners are not affected.

## Migration

1. In a client that calls a plain-HTTP listener at a non-loopback address, send `Origin` with the listener's scheme and authority exactly as the `Host` header names it, for example `Origin: http://192.0.2.5:3080`.
2. Alternatively serve the listener over HTTPS with the webserver's `tls` configuration, or reach it through a loopback port forward such as `ssh -L 3080:127.0.0.1:3080`.
3. Send exactly one `Host` header.
4. Confirm by repeating the call: the 403 becomes the route's own answer, such as 200 or 401.
