/*!
 * private.js - hd private keys for bcoin
 * Copyright (c) 2015-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('../env');
var utils = require('../utils/utils');
var crypto = require('../crypto/crypto');
var ec = require('../crypto/ec');
var assert = utils.assert;
var constants = bcoin.constants;
var networks = bcoin.networks;
var BufferWriter = require('../utils/writer');
var BufferReader = require('../utils/reader');
var HD = require('./hd');

/*
 * Constants
 */

var FINGER_PRINT = new Buffer('00000000', 'hex');
var SEED_SALT = new Buffer('Bitcoin seed', 'ascii');

/**
 * HDPrivateKey
 * @exports HDPrivateKey
 * @constructor
 * @param {Object|Base58String} options
 * @param {Base58String?} options.xkey - Serialized base58 key.
 * @param {Mnemonic?} options.mnemonic
 * @param {Number?} options.depth
 * @param {Buffer?} options.parentFingerPrint
 * @param {Number?} options.childIndex
 * @param {Buffer?} options.chainCode
 * @param {Buffer?} options.privateKey
 * @property {Network} network
 * @property {Base58String} xprivkey
 * @property {Base58String} xpubkey
 * @property {Mnemonic?} mnemonic
 * @property {Number} depth
 * @property {Buffer} parentFingerPrint
 * @property {Number} childIndex
 * @property {Buffer} chainCode
 * @property {Buffer} privateKey
 * @property {HDPublicKey} hdPublicKey
 */

function HDPrivateKey(options) {
  if (!(this instanceof HDPrivateKey))
    return new HDPrivateKey(options);

  this.network = bcoin.network.get();
  this.depth = 0;
  this.parentFingerPrint = FINGER_PRINT;
  this.childIndex = 0;
  this.chainCode = constants.ZERO_HASH;
  this.privateKey = constants.ZERO_HASH;

  this.publicKey = constants.ZERO_KEY;
  this.fingerPrint = null;

  this.mnemonic = null;

  this._xprivkey = null;

  this.hdPrivateKey = this;
  this._hdPublicKey = null;

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

HDPrivateKey.prototype.fromOptions = function fromOptions(options) {
  assert(options, 'No options for HD private key.');
  assert(utils.isNumber(options.depth));
  assert(Buffer.isBuffer(options.parentFingerPrint));
  assert(utils.isNumber(options.childIndex));
  assert(Buffer.isBuffer(options.chainCode));
  assert(Buffer.isBuffer(options.privateKey));
  assert(options.depth <= 0xff, 'Depth is too high.');

  if (options.network)
    this.network = bcoin.network.get(options.network);

  this.depth = options.depth;
  this.parentFingerPrint = options.parentFingerPrint;
  this.childIndex = options.childIndex;
  this.chainCode = options.chainCode;
  this.privateKey = options.privateKey;
  this.publicKey = ec.publicKeyCreate(options.privateKey, true);

  if (options.mnemonic) {
    assert(options.mnemonic instanceof HD.Mnemonic);
    this.mnemonic = options.mnemonic;
  }

  if (options.xprivkey) {
    assert(typeof options.xprivkey === 'string');
    this._xprivkey = options.xprivkey;
  }

  return this;
};

/**
 * Instantiate HD private key from options object.
 * @param {Object} options
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromOptions = function fromOptions(options) {
  return new HDPrivateKey().fromOptions(options);
};

HDPrivateKey.prototype.__defineGetter__('hdPublicKey', function() {
  var key = this._hdPublicKey;

  if (!key) {
    key = new HD.PublicKey();
    key.network = this.network;
    key.depth = this.depth;
    key.parentFingerPrint = this.parentFingerPrint;
    key.childIndex = this.childIndex;
    key.chainCode = this.chainCode;
    key.publicKey = this.publicKey;
    this._hdPublicKey = key;
  }

  return key;
});

HDPrivateKey.prototype.__defineGetter__('xprivkey', function() {
  if (!this._xprivkey)
    this._xprivkey = this.toBase58();
  return this._xprivkey;
});

HDPrivateKey.prototype.__defineGetter__('xpubkey', function() {
  return this.hdPublicKey.xpubkey;
});

/**
 * Destroy the key (zeroes chain code, privkey, and pubkey).
 * @param {Boolean} pub - Destroy hd public key as well.
 */

HDPrivateKey.prototype.destroy = function destroy(pub) {
  this.depth = 0;
  this.parentFingerPrint.fill(0);
  this.childIndex = 0;
  this.chainCode.fill(0);
  this.privateKey.fill(0);
  this.publicKey.fill(0);

  if (this.fingerPrint) {
    this.fingerPrint.fill(0);
    this.fingerPrint = null;
  }

  if (this._hdPublicKey) {
    if (pub)
      this._hdPublicKey.destroy();
    this._hdPublicKey = null;
  }

  this._xprivkey = null;

  if (this.mnemonic) {
    this.mnemonic.destroy();
    this.mnemonic = null;
  }
};

/**
 * Derive a child key.
 * @param {Number|String} - Child index or path.
 * @param {Boolean?} hardened - Whether the derivation should be hardened.
 * @returns {HDPrivateKey}
 */

HDPrivateKey.prototype.derive = function derive(index, hardened) {
  var p, id, data, hash, left, right, key, child;

  if (typeof index === 'string')
    return this.derivePath(index);

  hardened = index >= constants.hd.HARDENED ? true : hardened;

  if (index < constants.hd.HARDENED && hardened)
    index += constants.hd.HARDENED;

  if (!(index >= 0 && index < constants.hd.MAX_INDEX))
    throw new Error('Index out of range.');

  if (this.depth >= 0xff)
    throw new Error('Depth too high.');

  id = this.getID(index);
  child = HD.cache.get(id);

  if (child)
    return child;

  p = new BufferWriter();

  if (hardened) {
    p.writeU8(0);
    p.writeBytes(this.privateKey);
    p.writeU32BE(index);
  } else {
    p.writeBytes(this.publicKey);
    p.writeU32BE(index);
  }

  data = p.render();

  hash = crypto.hmac('sha512', data, this.chainCode);
  left = hash.slice(0, 32);
  right = hash.slice(32, 64);

  try {
    key = ec.privateKeyTweakAdd(this.privateKey, left);
  } catch (e) {
    return this.derive(index + 1);
  }

  if (!this.fingerPrint)
    this.fingerPrint = crypto.hash160(this.publicKey).slice(0, 4);

  child = new HDPrivateKey();
  child.network = this.network;
  child.depth = this.depth + 1;
  child.parentFingerPrint = this.fingerPrint;
  child.childIndex = index;
  child.chainCode = right;
  child.privateKey = key;
  child.publicKey = ec.publicKeyCreate(key, true);

  HD.cache.set(id, child);

  return child;
};

/**
 * Unique HD key ID.
 * @private
 * @param {Number} index
 * @returns {String}
 */

HDPrivateKey.prototype.getID = function getID(index) {
  return this.network.keyPrefix.xprivkey58
    + this.publicKey.toString('hex')
    + index;
};

/**
 * Derive a BIP44 account key.
 * @param {Number} accountIndex
 * @returns {HDPrivateKey}
 * @throws Error if key is not a master key.
 */

HDPrivateKey.prototype.deriveAccount44 = function deriveAccount44(accountIndex) {
  assert(utils.isNumber(accountIndex), 'Account index must be a number.');
  assert(this.isMaster(), 'Cannot derive account index.');
  return this
    .derive(44, true)
    .derive(this.network.keyPrefix.coinType, true)
    .derive(accountIndex, true);
};

/**
 * Derive a BIP45 purpose key.
 * @returns {HDPrivateKey}
 */

HDPrivateKey.prototype.derivePurpose45 = function derivePurpose45() {
  assert(this.isMaster(), 'Cannot derive purpose 45.');
  return this.derive(45, true);
};

/**
 * Test whether the key is a master key.
 * @returns {Boolean}
 */

HDPrivateKey.prototype.isMaster = function isMaster() {
  return this.depth === 0
    && this.childIndex === 0
    && this.parentFingerPrint.readUInt32LE(0, true) === 0;
};

/**
 * Test whether the key is (most likely) a BIP44 account key.
 * @param {Number?} accountIndex
 * @returns {Boolean}
 */

HDPrivateKey.prototype.isAccount44 = function isAccount44(accountIndex) {
  if (accountIndex != null) {
    if (this.childIndex !== constants.hd.HARDENED + accountIndex)
      return false;
  }
  return this.depth === 3 && this.childIndex >= constants.hd.HARDENED;
};

/**
 * Test whether the key is a BIP45 purpose key.
 * @returns {Boolean}
 */

HDPrivateKey.prototype.isPurpose45 = function isPurpose45() {
  return this.depth === 1 && this.childIndex === constants.hd.HARDENED + 45;
};

/**
 * Test whether an object is in the form of a base58 xprivkey.
 * @param {String} data
 * @returns {Boolean}
 */

HDPrivateKey.isExtended = function isExtended(data) {
  var i, type, prefix;

  if (typeof data !== 'string')
    return false;

  for (i = 0; i < networks.types.length; i++) {
    type = networks.types[i];
    prefix = networks[type].keyPrefix.xprivkey58;
    if (data.indexOf(prefix) === 0)
      return true;
  }

  return false;
};

/**
 * Test whether a buffer has a valid network prefix.
 * @param {Buffer} data
 * @returns {NetworkType}
 */

HDPrivateKey.hasPrefix = function hasPrefix(data) {
  var i, version, prefix, type;

  if (!Buffer.isBuffer(data))
    return false;

  version = data.readUInt32BE(0, true);

  for (i = 0; i < networks.types.length; i++) {
    type = networks.types[i];
    prefix = networks[type].keyPrefix.xprivkey;
    if (version === prefix)
      return type;
  }

  return false;
};

/**
 * Test whether a string is a valid path.
 * @param {String} path
 * @param {Boolean?} hardened
 * @returns {Boolean}
 */

HDPrivateKey.isValidPath = function isValidPath(path) {
  if (typeof path !== 'string')
    return false;

  try {
    HD.parsePath(path, constants.hd.MAX_INDEX);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Derive a key from a derivation path.
 * @param {String} path
 * @returns {HDPrivateKey}
 * @throws Error if `path` is not a valid path.
 */

HDPrivateKey.prototype.derivePath = function derivePath(path) {
  var indexes = HD.parsePath(path, constants.hd.MAX_INDEX);
  var key = this;
  var i;

  for (i = 0; i < indexes.length; i++)
    key = key.derive(indexes[i]);

  return key;
};

/**
 * Compare a key against an object.
 * @param {Object} obj
 * @returns {Boolean}
 */

HDPrivateKey.prototype.equal = function equal(obj) {
  if (!HDPrivateKey.isHDPrivateKey(obj))
    return false;

  return this.network === obj.network
    && this.depth === obj.depth
    && utils.equal(this.parentFingerPrint, obj.parentFingerPrint)
    && this.childIndex === obj.childIndex
    && utils.equal(this.chainCode, obj.chainCode)
    && utils.equal(this.privateKey, obj.privateKey);
};

/**
 * Compare a key against an object.
 * @param {Object} obj
 * @returns {Boolean}
 */

HDPrivateKey.prototype.compare = function compare(key) {
  var cmp;

  if (!HDPrivateKey.isHDPrivateKey(key))
    return 1;

  cmp = this.depth - key.depth;

  if (cmp !== 0)
    return cmp;

  cmp = utils.cmp(this.parentFingerPrint, key.parentFingerPrint);

  if (cmp !== 0)
    return cmp;

  cmp = this.childIndex - key.childIndex;

  if (cmp !== 0)
    return cmp;

  cmp = utils.cmp(this.chainCode, key.chainCode);

  if (cmp !== 0)
    return cmp;

  cmp = utils.cmp(this.privateKey, key.privateKey);

  if (cmp !== 0)
    return cmp;

  return 0;
};

/**
 * Inject properties from seed.
 * @private
 * @param {Buffer} seed
 * @param {(Network|NetworkType)?} network
 */

HDPrivateKey.prototype.fromSeed = function fromSeed(seed, network) {
  var hash, left, right;

  assert(Buffer.isBuffer(seed));

  if (!(seed.length * 8 >= constants.hd.MIN_ENTROPY
      && seed.length * 8 <= constants.hd.MAX_ENTROPY)) {
    throw new Error('Entropy not in range.');
  }

  hash = crypto.hmac('sha512', seed, SEED_SALT);

  left = hash.slice(0, 32);
  right = hash.slice(32, 64);

  // Only a 1 in 2^127 chance of happening.
  if (!ec.privateKeyVerify(left))
    throw new Error('Master private key is invalid.');

  this.network = bcoin.network.get(network);
  this.depth = 0;
  this.parentFingerPrint = new Buffer([0, 0, 0, 0]);
  this.childIndex = 0;
  this.chainCode = right;
  this.privateKey = left;
  this.publicKey = ec.publicKeyCreate(left, true);

  return this;
};

/**
 * Instantiate an hd private key from a 512 bit seed.
 * @param {Buffer} seed
 * @param {(Network|NetworkType)?} network
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromSeed = function fromSeed(seed, network) {
  return new HDPrivateKey().fromSeed(seed, network);
};

/**
 * Inject properties from a mnemonic.
 * @private
 * @param {Mnemonic|Object} mnemonic
 * @param {(Network|NetworkType)?} network
 */

HDPrivateKey.prototype.fromMnemonic = function fromMnemonic(mnemonic, network) {
  if (!(mnemonic instanceof HD.Mnemonic))
    mnemonic = new HD.Mnemonic(mnemonic);
  this.fromSeed(mnemonic.toSeed(), network);
  this.mnemonic = mnemonic;
  return this;
};

/**
 * Instantiate an hd private key from a mnemonic.
 * @param {Mnemonic|Object} mnemonic
 * @param {(Network|NetworkType)?} network
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromMnemonic = function fromMnemonic(mnemonic, network) {
  return new HDPrivateKey().fromMnemonic(mnemonic, network);
};

/**
 * Inject properties from privateKey and entropy.
 * @private
 * @param {Buffer} key
 * @param {Buffer} entropy
 * @param {(Network|NetworkType)?} network
 */

HDPrivateKey.prototype.fromKey = function fromKey(key, entropy, network) {
  assert(Buffer.isBuffer(key) && key.length === 32);
  assert(Buffer.isBuffer(entropy) && entropy.length === 32);
  this.network = bcoin.network.get(network);
  this.depth = 0;
  this.parentFingerPrint = new Buffer([0, 0, 0, 0]);
  this.childIndex = 0;
  this.chainCode = entropy;
  this.privateKey = key;
  this.publicKey = ec.publicKeyCreate(key, true);
  return this;
};

/**
 * Create an hd private key from a key and entropy bytes.
 * @param {Buffer} key
 * @param {Buffer} entropy
 * @param {(Network|NetworkType)?} network
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromKey = function fromKey(key, entropy, network) {
  return new HDPrivateKey().fromKey(key, entropy, network);
};

/**
 * Generate an hd private key.
 * @param {(Network|NetworkType)?} network
 * @returns {HDPrivateKey}
 */

HDPrivateKey.generate = function generate(network) {
  var key = ec.generatePrivateKey();
  var entropy = crypto.randomBytes(32);
  return HDPrivateKey.fromKey(key, entropy, network);
};

/**
 * Inject properties from base58 key.
 * @private
 * @param {Base58String} xkey
 */

HDPrivateKey.prototype.fromBase58 = function fromBase58(xkey) {
  this.fromRaw(utils.fromBase58(xkey));
  this._xprivkey = xkey;
  return this;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} raw
 */

HDPrivateKey.prototype.fromRaw = function fromRaw(raw) {
  var p = new BufferReader(raw);
  var i, version, type, prefix;

  version = p.readU32BE();
  this.depth = p.readU8();
  this.parentFingerPrint = p.readBytes(4);
  this.childIndex = p.readU32BE();
  this.chainCode = p.readBytes(32);
  p.readU8();
  this.privateKey = p.readBytes(32);
  p.verifyChecksum();

  for (i = 0; i < networks.types.length; i++) {
    type = networks.types[i];
    prefix = networks[type].keyPrefix.xprivkey;
    if (version === prefix)
      break;
  }

  assert(i < networks.types.length, 'Network not found.');

  this.publicKey = ec.publicKeyCreate(this.privateKey, true);
  this.network = bcoin.network.get(type);

  return this;
};

/**
 * Serialize key to a base58 string.
 * @param {(Network|NetworkType)?} network
 * @returns {Base58String}
 */

HDPrivateKey.prototype.toBase58 = function toBase58(network) {
  return utils.toBase58(this.toRaw(network));
};

/**
 * Serialize the key.
 * @param {(Network|NetworkType)?} network
 * @returns {Buffer}
 */

HDPrivateKey.prototype.toRaw = function toRaw(network, writer) {
  var p = new BufferWriter(writer);

  if (!network)
    network = this.network;

  network = bcoin.network.get(network);

  p.writeU32BE(network.keyPrefix.xprivkey);
  p.writeU8(this.depth);
  p.writeBytes(this.parentFingerPrint);
  p.writeU32BE(this.childIndex);
  p.writeBytes(this.chainCode);
  p.writeU8(0);
  p.writeBytes(this.privateKey);
  p.writeChecksum();

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Serialize the key in "extended"
 * format (includes the mnemonic).
 * @param {(Network|NetworkType)?} network
 * @returns {Buffer}
 */

HDPrivateKey.prototype.toExtended = function toExtended(network, writer) {
  var p = new BufferWriter(writer);

  this.toRaw(network, p);

  if (this.mnemonic) {
    p.writeU8(1);
    this.mnemonic.toRaw(p);
  } else {
    p.writeU8(0);
  }

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from extended serialized data.
 * @private
 * @param {Buffer} data
 */

HDPrivateKey.prototype.fromExtended = function fromExtended(data) {
  var p = new BufferReader(data);
  this.fromRaw(p);
  if (p.readU8() === 1)
    this.mnemonic = HD.Mnemonic.fromRaw(p);
  return this;
};

/**
 * Instantiate key from "extended" serialized data.
 * @param {Buffer} data
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromExtended = function fromExtended(data) {
  return new HDPrivateKey().fromExtended(data);
};

/**
 * Instantiate an HD private key from a base58 string.
 * @param {Base58String} xkey
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromBase58 = function fromBase58(xkey) {
  return new HDPrivateKey().fromBase58(xkey);
};

/**
 * Instantiate key from serialized data.
 * @param {Buffer} raw
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromRaw = function fromRaw(raw) {
  return new HDPrivateKey().fromRaw(raw);
};

/**
 * Convert key to a more json-friendly object.
 * @returns {Object}
 */

HDPrivateKey.prototype.toJSON = function toJSON() {
  return {
    xprivkey: this.xprivkey,
    mnemonic: this.mnemonic ? this.mnemonic.toJSON() : null
  };
};

/**
 * Inject properties from json object.
 * @private
 * @param {Object} json
 */

HDPrivateKey.prototype.fromJSON = function fromJSON(json) {
  assert(json.xprivkey, 'Could not handle key JSON.');

  this.fromBase58(json.xprivkey);

  if (json.mnemonic)
    this.mnemonic = HD.Mnemonic.fromJSON(json.mnemonic);

  return this;
};

/**
 * Instantiate an HDPrivateKey from a jsonified key object.
 * @param {Object} json - The jsonified key object.
 * @returns {HDPrivateKey}
 */

HDPrivateKey.fromJSON = function fromJSON(json) {
  return new HDPrivateKey().fromJSON(json);
};

/**
 * Test whether an object is an HDPrivateKey.
 * @param {Object} obj
 * @returns {Boolean}
 */

HDPrivateKey.isHDPrivateKey = function isHDPrivateKey(obj) {
  return obj
    && typeof obj.derive === 'function'
    && typeof obj.toExtended === 'function'
    && obj.chainCode !== undefined;
};

/*
 * Expose
 */

module.exports = HDPrivateKey;
