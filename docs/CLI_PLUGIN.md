# CLI 动态插件（无需重编译主程序）

`myfinger` 支持在运行时加载 `module.json` 形式的 CLI 插件。

## 1. 插件目录

- 默认目录：`~/.finger/plugins/cli`
- 可覆盖：环境变量 `FINGER_CLI_PLUGIN_DIR`

## 2. module.json 格式

```json
{
  "id": "hello-plugin",
  "type": "cli-plugin",
  "name": "Hello Plugin",
  "version": "1.0.0",
  "entry": "/absolute/path/to/hello-plugin.js",
  "enabled": true
}
```

`entry` 也可写相对路径（相对 `module.json` 所在目录）。

## 3. 插件 JS 导出

```js
export default {
  register(program, context) {
    program.command('hello-plugin').action(() => {
      console.log('hello from plugin');
    });
  }
};
```

`context` 包含：
- `defaultHttpBaseUrl`
- `defaultWsUrl`
- `cliVersion`

## 4. 管理命令

- `myfinger plugin list`
- `myfinger plugin register -m /path/to/module.json`
- `myfinger plugin register -m /path/to/module.json --mode capability`
- `myfinger plugin unregister -i <pluginId>`
- `myfinger plugin unregister -i <pluginId> --mode capability`
- `myfinger plugin register-file -i <id> -n <name> -f /path/to/plugin.js`
- `myfinger plugin register-file -i <id> -n <name> -f /path/to/plugin.js --mode capability`

`mode=plugin` 默认目录：`~/.finger/plugins/cli`  
`mode=capability` 默认目录：`~/.finger/capabilities/cli`

## 5. MessageHub 模块动态挂载

Daemon 侧支持两种方式：
- `myfinger daemon register-module -f /path/to/module.js`
- `myfinger daemon register-module -m /path/to/module.json`

`~/.finger/autostart` 目录也支持放置 `.module.json`（`type=input/output/agent`），daemon 启动后自动注册。
