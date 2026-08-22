## @durion-sdk/mcp-server@0.1.0-alpha

> **Known limitation — `streamMcpChat` is not usable as generated.**
>
> `POST /v1/mcp/chat/stream` returns `text/event-stream`, but the backend spec
> types its 200 response as `type: array` of `ServerSentEventString` (springdoc's
> rendering of `Flux<ServerSentEvent<String>>`). `typescript-fetch` keys off the
> schema rather than the media type, so the generated `streamMcpChatRaw` wraps
> the response in `JSONApiResponse` and calls `response.json()`. That throws on
> an SSE body, and would buffer the whole stream even if it parsed — defeating
> the incremental token delivery the endpoint exists for.
>
> Consume this endpoint with `fetch` and an SSE reader directly until the spec is
> corrected. The blocking `executeMcpChat` on `McpChatControllerApi` is
> unaffected, as is every other API in this package.
>
> Tracked in durion-positivity-backend#1455.


This generator creates TypeScript/JavaScript client that utilizes [Fetch API](https://fetch.spec.whatwg.org/). The generated Node module can be used in the following environments:

Environment
* Node.js
* Webpack
* Browserify

Language level
* ES5 - you must have a Promises/A+ library installed
* ES6

Module system
* CommonJS
* ES6 module system

It can be used in both TypeScript and JavaScript. In TypeScript, the definition will be automatically resolved via `package.json`. ([Reference](https://www.typescriptlang.org/docs/handbook/declaration-files/consumption.html))

### Building

To build and compile the typescript sources to javascript use:
```
npm install
npm run build
```

### Publishing

First build the package then run `npm publish`

### Consuming

navigate to the folder of your consuming project and run one of the following commands.

_published:_

```
npm install @durion-sdk/mcp-server@0.1.0-alpha --save
```

_unPublished (not recommended):_

```
npm install PATH_TO_GENERATED_PACKAGE --save
```
