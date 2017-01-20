var MAXSHIP, TempFile, findit, fork, fs, knox, path, temp, uuid, winston,
  extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
  hasProp = {}.hasOwnProperty;

knox = require('knox');

winston = require('winston');

fs = require('fs');

uuid = require('node-uuid');

findit = require('findit');

path = require('path');

temp = require('temp');

fork = require('child_process').fork;

MAXSHIP = 5;

TempFile = function(logFilePath, tempFlag) {
  if (tempFlag) {
    return temp.createWriteStream();
  }
  return fs.createWriteStream(path.join(logFilePath, 's3logger_' + (new Date().toISOString()).replace(/:/g, '_')));
};

module.exports = winston.transports.S3 = (function(superClass) {
  extend(S3, superClass);

  S3.prototype.name = 's3';

  function S3(opts) {
    if (opts == null) {
      opts = {};
    }
    S3.__super__.constructor.apply(this, arguments);
    this.client = knox.createClient({
      key: opts.key,
      secret: opts.secret,
      bucket: opts.bucket,
      region: opts.region || "us-east-1"
    });
    this.bufferSize = 0;
    this.maxSize = opts.maxSize || 20 * 1024 * 1024;
    this._id = opts.id || (require('os')).hostname();
    this._nested = opts.nested || false;
    this._path = opts.path || path.resolve(__dirname, 's3logs');
    this._temp = opts.temp || false;
    this._debug = opts.debug || false;
    this._headers = opts.headers || {};
    if (!this._temp) {
      fs.mkdir(path.resolve(this._path), 0x1f8, (function(_this) {
        return function(err) {
          if (err != null) {
            if (err.code === 'EEXIST') {
              return;
            }
          }
          if (err) {
            return console.log('Error creating temp dir', err);
          }
        };
      })(this));
    }
  }

  S3.prototype.log = function(level, msg, meta, cb) {
    var item;
    if (msg == null) {
      msg = '';
    }
    if (this.silent) {
      cb(null, true);
    }
    item = {};
    if (this._nested) {
      if (meta != null) {
        item.meta = meta;
      }
    } else {
      if (meta != null) {
        item = meta;
      }
    }
    item.s3_msg = msg;
    item.s3_level = level;
    item.s3_time = new Date().toISOString();
    item.s3_id = this._id;
    item = JSON.stringify(item) + '\n';
    return this.open((function(_this) {
      return function(newFileRequired) {
        _this.bufferSize += item.length;
        _this._stream.write(item);
        _this.emit("logged");
        return cb(null, true);
      };
    })(this));
  };

  S3.prototype.timeForNewLog = function() {
    return (this.maxSize && this.bufferSize >= this.maxSize) && (this.maxTime && this.openedAt && new Date - this.openedAt > this.maxTime);
  };

  S3.prototype.open = function(cb) {
    if (this.opening) {
      return cb(true);
    } else if (!this._stream || this.maxSize && this.bufferSize >= this.maxSize) {
      this._createStream(cb);
      return cb(true);
    } else {
      return cb();
    }
  };

  S3.prototype.shipIt = function(logFilePath) {
    return this.queueIt(logFilePath);
  };

  S3.prototype.queueIt = function(logFilePath) {
    if (this.shipQueue === void 0) {
      this.shipQueue = {};
    }
    if (this.shipQueue[logFilePath] != null) {
      return;
    }
    this.shipQueue[logFilePath] = logFilePath;
    if (this._debug) {
      console.log("@shipQueue is " + (JSON.stringify(this.shipQueue)));
    }
    return this._shipNow();
  };

  S3.prototype._shipNow = function(cb) {
    cb = typeof cb === 'function' ? cb : function () {}
    var keys, logFilePath;
    if (this.shipping == null) {
      this.shipping = 0;
    }
    if (this.shipping >= MAXSHIP) {
      return;
    }
    keys = Object.keys(this.shipQueue);
    if (keys.length < 1) {
      return;
    }
    this.shipping++;
    logFilePath = keys[0];
    delete this.shipQueue[logFilePath];
    return new Promise((function (__this) {
      return function(resolve, reject) {
        __this.client.putFile(logFilePath, __this._s3Path(), __this._headers, (function(_this) {
          return function(err, res) {
            _this.shipping--;
            _this._shipNow();
            if (err != null) {
              if (err.code !== 'ENOENT') {
                _this.shipQueue[logFilePath] = logFilePath;
              }
              console.error('Error shipping file', err);
              reject(err)
              return cb(err, null)
            }
            if (res.statusCode !== 200) {
              _this.shipQueue[logFilePath] = logFilePath;
              console.error("S3 error, code " + res.statusCode);
              reject(err)
              return cb(err, null)
            }
            if (_this._debug) {
              console.log(res);
            }
            fs.unlink(logFilePath, function(err) {
              if (err) {
                console.error('Error unlinking file', err);
                reject(err)
                return cb(err, null)
              } else {
                resolve(true)
                return cb(null, true)
              }
            });
          };
        })(__this));
      }
    })(this))
  };

  S3.prototype._s3Path = function() {
    var d;
    d = new Date;
    return "/year=" + (d.getUTCFullYear()) + "/month=" + (d.getUTCMonth() + 1) + "/day=" + (d.getUTCDate()) + "/" + (d.toISOString()) + "_" + this._id + "_" + (uuid.v4().slice(0, 8)) + ".json";
  };

  S3.prototype.checkUnshipped = function() {
    var unshippedFiles;
    unshippedFiles = findit.find(path.resolve(this._path));
    return unshippedFiles.on('file', (function(_this) {
      return function(logFilePath) {
        return (function(logFilePath) {
          if (!logFilePath.match('s3logger.+Z')) {
            return;
          }
          if (_this._debug) {
            console.log("Matched on " + logFilePath);
          }
          if (_this._stream) {
            if (path.resolve(logFilePath) === path.resolve(_this._stream.path)) {
              return;
            }
          }
          return _this.shipIt(logFilePath);
        })(logFilePath);
      };
    })(this));
  };

  S3.prototype._createStream = function() {
    var stream;
    this.opening = true;
    if (this._stream) {
      stream = this._stream;
      stream.end();
      stream.on('close', (function(_this) {
        return function() {
          return _this.shipIt(stream.path);
        };
      })(this));
      stream.on('drain', function() {});
      stream.destroySoon();
    }
    this.bufferSize = 0;
    this._stream = new TempFile(this._path, this._temp);
    this._path = path.dirname(this._stream.path);
    if (this._debug) {
      console.log("@_path is " + this._path);
    }
    this.checkUnshipped();
    this.opening = false;
    this._stream.setMaxListeners(Infinity);
    return this.once("flush", function() {
      this.opening = false;
      this.emit("open", this._stream.path);
      return this.flush();
    });
  };

  return S3;

})(winston.Transport);

// ---
// generated by coffee-script 1.9.2