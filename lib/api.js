var apiCache = {}

function Api (app, options) {
  this.app = app
  this.requireName = options.requireName || 'require'
}

Api.prototype.initialize = function () {
  return this.load().then(this.addApiCommands.bind(this))
}

Api.prototype.addApiCommands = function (api) {
  this.addRenderProcessApis(api.electron)
  this.addMainProcessApis(api.electron.remote)
  this.addBrowserWindowApis(api.browserWindow)
  this.addWebContentsApis(api.webContents)
  this.addProcessApis(api.rendererProcess)

  this.api = {
    browserWindow: api.browserWindow,
    electron: api.electron,
    rendererProcess: api.rendererProcess,
    webContents: api.webContents
  }

  this.addClientProperties()
}

Api.prototype.load = function () {
  var self = this
  console.log('Load start');
  return this.isNodeIntegrationEnabled().then(function (nodeIntegration) {
    self.nodeIntegration = nodeIntegration
    console.log('Nodeintegration:', nodeIntegration);
    if (!nodeIntegration) {
      return {
        electron: {remote: {}},
        browserWindow: {},
        webContents: {},
        rendererProcess: {}
      }
    }

    return self.getVersion().then(function (version) {
      console.log('Version:', version);
      var api = apiCache[version]
      console.log('API:', api);
      if (api) return api

      return self.loadApi().then(function (api) {
        console.log('Loaded API:', api);
        apiCache[version] = api
        return api
      })
    })
  })
}

Api.prototype.isNodeIntegrationEnabled = function () {
  return this.app.client.execute(function () {
    return typeof process !== 'undefined'
  }).then(getResponseValue)
}

Api.prototype.getVersion = function () {
  return this.app.client.execute(function () {
    return process.versions.electron
  }).then(getResponseValue)
}

Api.prototype.loadApi = function () {
  return this.app.client.execute(function (requireName) {
    var electron = window[requireName]('electron')

    var api = {
      browserWindow: {},
      electron: {},
      rendererProcess: {},
      webContents: {}
    }

    function ignoreModule (moduleName) {
      switch (moduleName) {
        case 'CallbacksRegistry':
        case 'deprecate':
        case 'deprecations':
        case 'hideInternalModules':
        case 'Tray':
          return true
      }
      return false
    }

    function isRemoteFunction (name) {
      switch (name) {
        case 'BrowserWindow':
        case 'Menu':
        case 'MenuItem':
          return false
      }
      return typeof electron.remote[name] === 'function'
    }

    function ignoreApi (apiName) {
      switch (apiName) {
        case 'prototype':
          return true
        default:
          return apiName[0] === '_'
      }
    }

    function addModule (parent, parentName, name, api) {
      api[name] = {}
      for (var key in parent[name]) {
        if (ignoreApi(key)) continue
        api[name][key] = parentName + '.' + name + '.' + key
      }
    }

    function addRenderProcessModules () {
      Object.getOwnPropertyNames(electron).forEach(function (key) {
        if (ignoreModule(key)) return
        if (key === 'remote') return
        addModule(electron, 'electron', key, api.electron)
      })
    }

    function addMainProcessModules () {
      api.electron.remote = {}
      Object.getOwnPropertyNames(electron.remote).forEach(function (key) {
        if (ignoreModule(key)) return
        if (isRemoteFunction(key)) {
          api.electron.remote[key] = 'electron.remote.' + key
        } else {
          addModule(electron.remote, 'electron.remote', key, api.electron.remote)
        }
      })
      addModule(electron.remote, 'electron.remote', 'process', api.electron.remote)
    }

    function addBrowserWindow () {
      var currentWindow = electron.remote.getCurrentWindow()
      for (var name in currentWindow) {
        if (ignoreApi(name)) continue
        var value = currentWindow[name]
        if (typeof value === 'function') {
          api.browserWindow[name] = 'browserWindow.' + name
        }
      }
    }

    function addWebContents () {
      var webContents = electron.remote.getCurrentWebContents()
      for (var name in webContents) {
        if (ignoreApi(name)) continue
        var value = webContents[name]
        if (typeof value === 'function') {
          api.webContents[name] = 'webContents.' + name
        }
      }
    }

    function addProcess () {
      for (var name in process) {
        if (ignoreApi(name)) continue
        api.rendererProcess[name] = 'process.' + name
      }
    }

    addRenderProcessModules()
    addMainProcessModules()
    addBrowserWindow()
    addWebContents()
    addProcess()

    return api
  }, this.requireName).then(getResponseValue)
}

Api.prototype.addClientProperty = function (name) {
  var self = this

  var clientPrototype = Object.getPrototypeOf(self.app.client)
  Object.defineProperty(clientPrototype, name, {
    get: function () {
      var client = this
      return transformObject(self.api[name], {}, function (value) {
        return client[value].bind(client)
      })
    }
  })
}

Api.prototype.addClientProperties = function () {
  this.addClientProperty('electron')
  this.addClientProperty('browserWindow')
  this.addClientProperty('webContents')
  this.addClientProperty('rendererProcess')

  Object.defineProperty(Object.getPrototypeOf(this.app.client), 'mainProcess', {
    get: function () {
      return this.electron.remote.process
    }
  })
}

Api.prototype.addRenderProcessApis = function (api) {
  var app = this.app
  var self = this
  var electron = {}
  app.electron = electron

  Object.keys(api).forEach(function (moduleName) {
    if (moduleName === 'remote') return
    electron[moduleName] = {}
    var moduleApi = api[moduleName]

    Object.keys(moduleApi).forEach(function (key) {
      var commandName = moduleApi[key]

      app.client.addCommand(commandName, function () {
        var args = Array.prototype.slice.call(arguments)
        return this.execute(callRenderApi, moduleName, key, args, self.requireName).then(getResponseValue)
      })

      electron[moduleName][key] = function () {
        return app.client[commandName].apply(app.client, arguments)
      }
    })
  })
}

Api.prototype.addMainProcessApis = function (api) {
  var app = this.app
  var self = this
  var remote = {}
  app.electron.remote = remote

  Object.keys(api).filter(function (propertyName) {
    return typeof api[propertyName] === 'string'
  }).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callMainApi, null, name, args, self.requireName).then(getResponseValue)
    })

    remote[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })

  Object.keys(api).filter(function (moduleName) {
    return typeof api[moduleName] === 'object'
  }).forEach(function (moduleName) {
    remote[moduleName] = {}
    var moduleApi = api[moduleName]

    Object.keys(moduleApi).forEach(function (key) {
      var commandName = moduleApi[key]

      app.client.addCommand(commandName, function () {
        var args = Array.prototype.slice.call(arguments)
        return this.execute(callMainApi, moduleName, key, args, self.requireName).then(getResponseValue)
      })

      remote[moduleName][key] = function () {
        return app.client[commandName].apply(app.client, arguments)
      }
    })
  })
}

Api.prototype.addBrowserWindowApis = function (api) {
  var app = this.app
  var self = this
  app.browserWindow = {}

  Object.keys(api).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callBrowserWindowApi, name, args, self.requireName).then(getResponseValue)
    })

    app.browserWindow[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })
}

Api.prototype.addWebContentsApis = function (api) {
  var app = this.app
  var self = this
  app.webContents = {}

  Object.keys(api).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callWebContentsApi, name, args, self.requireName).then(getResponseValue)
    })

    app.webContents[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })
}

Api.prototype.addProcessApis = function (api) {
  var app = this.app
  app.rendererProcess = {}

  Object.keys(api).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callProcessApi, name, args).then(getResponseValue)
    })

    app.rendererProcess[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })

  app.mainProcess = app.electron.remote.process
}

Api.prototype.transferPromiseness = function (target, promise) {
  this.app.client.transferPromiseness(target, promise)

  var addProperties = function (source, target, moduleName) {
    var sourceModule = source[moduleName]
    if (!sourceModule) return
    target[moduleName] = transformObject(sourceModule, {}, function (value, parent) {
      return value.bind(parent)
    })
  }

  addProperties(promise, target, 'webContents')
  addProperties(promise, target, 'browserWindow')
  addProperties(promise, target, 'electron')
  addProperties(promise, target, 'mainProcess')
  addProperties(promise, target, 'rendererProcess')
}

Api.prototype.logApi = function () {
  var fs = require('fs')
  var path = require('path')
  var json = JSON.stringify(this.api, null, 2)
  fs.writeFileSync(path.join(__dirname, 'api.json'), json)
}

function transformObject (input, output, callback) {
  Object.keys(input).forEach(function (name) {
    var value = input[name]
    if (typeof value === 'object') {
      output[name] = {}
      transformObject(value, output[name], callback)
    } else {
      output[name] = callback(value, input)
    }
  })
  return output
}

function callRenderApi (moduleName, api, args, requireName) {
  var module = window[requireName]('electron')[moduleName]
  if (typeof module[api] === 'function') {
    return module[api].apply(module, args)
  } else {
    return module[api]
  }
}

function callMainApi (moduleName, api, args, requireName) {
  var module = window[requireName]('electron').remote
  if (moduleName) {
    module = module[moduleName]
  }
  if (typeof module[api] === 'function') {
    return module[api].apply(module, args)
  } else {
    return module[api]
  }
}

function callWebContentsApi (name, args, requireName) {
  var webContents = window[requireName]('electron').remote.getCurrentWebContents()
  return webContents[name].apply(webContents, args)
}

function callBrowserWindowApi (name, args, requireName) {
  var browserWindow = window[requireName]('electron').remote.getCurrentWindow()
  return browserWindow[name].apply(browserWindow, args)
}

function callProcessApi (name, args) {
  if (typeof process[name] === 'function') {
    return process[name].apply(process, args)
  } else {
    return process[name]
  }
}

function getResponseValue (response) {
  return response.value
}

module.exports = Api
