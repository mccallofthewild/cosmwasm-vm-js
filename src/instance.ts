/*eslint-disable prefer-const */
import { bech32, BechLib } from 'bech32';
import { Region } from './memory';
import { ecdsaRecover, ecdsaVerify } from 'secp256k1';
import { IBackend, Record } from './backend';
import { Env, MessageInfo } from './types';
import { toByteArray, toNumber } from './helpers/byte-array';

export const MAX_LENGTH_DB_KEY: number = 64 * 1024;
export const MAX_LENGTH_DB_VALUE: number = 128 * 1024;
export const MAX_LENGTH_CANONICAL_ADDRESS: number = 64;
export const MAX_LENGTH_HUMAN_ADDRESS: number = 256;

export const MAX_LENGTH_ED25519_SIGNATURE: number = 64;
export const MAX_LENGTH_ED25519_MESSAGE: number = 128 * 1024;
export const EDDSA_PUBKEY_LEN: number = 32;

export class VMInstance {
  public instance?: WebAssembly.Instance;
  public bech32: BechLib;
  public debugMsgs: string[] = [];

  constructor(
    public backend: IBackend,
    public readonly gasLimit?: number | undefined
  ) {
    this.bech32 = bech32;
  }

  public async build(wasmByteCode: ArrayBuffer) {
    let imports = {
      env: {
        db_read: this.db_read.bind(this),
        db_write: this.db_write.bind(this),
        db_remove: this.db_remove.bind(this),
        db_scan: this.db_scan.bind(this),
        db_next: this.db_next.bind(this),
        addr_humanize: this.addr_humanize.bind(this),
        addr_canonicalize: this.addr_canonicalize.bind(this),
        addr_validate: this.addr_validate.bind(this),
        secp256k1_verify: this.secp256k1_verify.bind(this),
        secp256k1_recover_pubkey: this.secp256k1_recover_pubkey.bind(this),
        ed25519_verify: this.ed25519_verify.bind(this),
        ed25519_batch_verify: this.ed25519_batch_verify.bind(this),
        debug: this.debug.bind(this),
        query_chain: this.query_chain.bind(this),
        abort: this.abort.bind(this),
      },
    };

    const result = await WebAssembly.instantiate(wasmByteCode, imports);
    this.instance = result.instance;
  }

  public get exports(): any {
    if (!this.instance)
      throw new Error('Please init instance before using methods');
    return this.instance!.exports;
  }

  public get remainingGas() {
    return this.gasLimit; // TODO: implement
  }

  public allocate(size: number): Region {
    let { allocate, memory } = this.exports;
    let regPtr = allocate(size);
    return new Region(memory, regPtr);
  }

  public deallocate(region: Region): void {
    let { deallocate } = this.exports;
    deallocate(region.ptr);
  }

  public allocate_bytes(bytes: Uint8Array): Region {
    let region = this.allocate(bytes.length);
    region.write(bytes);
    return region;
  }

  public allocate_b64(b64: string): Region {
    let bytes = Buffer.from(b64, 'base64');
    return this.allocate_bytes(bytes as any);
  }

  public allocate_str(str: string): Region {
    const bytes = new TextEncoder().encode(str);
    let region = this.allocate(bytes.length);
    region.write(bytes);
    return region;
  }

  public allocate_json(obj: object): Region {
    const str = JSON.stringify(obj);
    return this.allocate_str(str);
  }

  public instantiate(env: Env, info: MessageInfo, msg: object): Region {
    let { instantiate } = this.exports;
    let args = [env, info, msg].map((x) => this.allocate_json(x).ptr);
    let result = instantiate(...args);
    return this.region(result);
  }

  public execute(env: Env, info: MessageInfo, msg: object): Region {
    let { execute } = this.exports;
    let args = [env, info, msg].map((x) => this.allocate_json(x).ptr);
    let result = execute(...args);
    return this.region(result);
  }

  public query(env: Env, msg: object): Region {
    let { query } = this.exports;
    let args = [env, msg].map((x) => this.allocate_json(x).ptr);
    let result = query(...args);
    return this.region(result);
  }

  public migrate(env: Env, msg: object): Region {
    let { migrate } = this.exports;
    let args = [env, msg].map((x) => this.allocate_json(x).ptr);
    let result = migrate(...args);
    return this.region(result);
  }

  public reply(env: Env, msg: object): Region {
    let { reply } = this.exports;
    let args = [env, msg].map((x) => this.allocate_json(x).ptr);
    let result = reply(...args);
    return this.region(result);
  }

  db_read(key_ptr: number): number {
    let key = this.region(key_ptr);
    return this.do_db_read(key).ptr;
  }

  db_write(key_ptr: number, value_ptr: number) {
    let key = this.region(key_ptr);
    let value = this.region(value_ptr);
    this.do_db_write(key, value);
  }

  db_remove(key_ptr: number) {
    let key = this.region(key_ptr);
    this.do_db_remove(key);
  }

  db_scan(start_ptr: number, end_ptr: number, order: number): number {
    let start = this.region(start_ptr);
    let end = this.region(end_ptr);
    return this.do_db_scan(start, end, order).ptr;
  }

  db_next(iterator_id_ptr: number): number {
    let iterator_id = this.region(iterator_id_ptr);
    return this.do_db_next(iterator_id).ptr;
  }

  addr_canonicalize(source_ptr: number, destination_ptr: number): number {
    let source = this.region(source_ptr);
    let destination = this.region(destination_ptr);
    return this.do_addr_canonicalize(source, destination).ptr;
  }

  addr_humanize(source_ptr: number, destination_ptr: number): number {
    let source = this.region(source_ptr);
    let destination = this.region(destination_ptr);
    return this.do_addr_humanize(source, destination).ptr;
  }

  addr_validate(source_ptr: number): number {
    let source = this.region(source_ptr);
    return this.do_addr_validate(source).ptr;
  }

  secp256k1_verify(
    hash_ptr: number,
    signature_ptr: number,
    pubkey_ptr: number
  ): number {
    let hash = this.region(hash_ptr);
    let signature = this.region(signature_ptr);
    let pubkey = this.region(pubkey_ptr);
    return this.do_secp256k1_verify(hash, signature, pubkey);
  }

  secp256k1_recover_pubkey(
    hash_ptr: number,
    signature_ptr: number,
    recover_param: number
  ): bigint {
    let hash = this.region(hash_ptr);
    let signature = this.region(signature_ptr);
    return BigInt(
      this.do_secp256k1_recover_pubkey(hash, signature, recover_param).ptr
    );
  }

  ed25519_verify(
    message_ptr: number,
    signature_ptr: number,
    pubkey_ptr: number
  ): number {
    let message = this.region(message_ptr);
    let signature = this.region(signature_ptr);
    let pubkey = this.region(pubkey_ptr);
    return this.do_ed25519_verify(message, signature, pubkey);
  }

  ed25519_batch_verify(
    messages_ptr: number,
    signatures_ptr: number,
    public_keys_ptr: number
  ): number {
    let messages = this.region(messages_ptr);
    let signatures = this.region(signatures_ptr);
    let public_keys = this.region(public_keys_ptr);
    return this.do_ed25519_batch_verify(messages, signatures, public_keys);
  }

  debug(message_ptr: number) {
    let message = this.region(message_ptr);
    this.do_debug(message);
  }

  query_chain(request_ptr: number): number {
    let request = this.region(request_ptr);
    return this.do_query_chain(request).ptr;
  }

  abort(message_ptr: number) {
    let message = this.region(message_ptr);
    this.do_abort(message);
  }

  public region(ptr: number): Region {
    return new Region(this.exports.memory, ptr);
  }

  do_db_read(key: Region): Region {
    let value: Uint8Array | null = this.backend.storage.get(key.data);

    if (key.str.length > MAX_LENGTH_DB_KEY) {
      throw new Error(
        `Key length ${key.str.length} exceeds maximum length ${MAX_LENGTH_DB_KEY}`
      );
    }

    if (value === null) {
      console.warn(`db_read: key not found: ${key.str}`);
      return this.region(0);
    }

    return this.allocate_bytes(value);
  }

  do_db_write(key: Region, value: Region) {
    if (value.str.length > MAX_LENGTH_DB_VALUE) {
      throw new Error(`db_write: value too large: ${value.str}`);
    }

    // throw error for large keys
    if (key.str.length > MAX_LENGTH_DB_KEY) {
      throw new Error(`db_write: key too large: ${key.str}`);
    }

    this.backend.storage.set(key.data, value.data);
  }

  do_db_remove(key: Region) {
    this.backend.storage.remove(key.data);
  }

  do_db_scan(start: Region, end: Region, order: number): Region {
    const iteratorId: Uint8Array = this.backend.storage.scan(
      start.data,
      end.data,
      order
    );

    let region = this.allocate(iteratorId.length);
    region.write(iteratorId);

    return region;
  }

  do_db_next(iterator_id: Region): Region {
    const record: Record | null = this.backend.storage.next(iterator_id.data);

    if (record === null) {
      return this.allocate_bytes(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]));
    }

    return this.allocate_bytes(
      new Uint8Array([
        ...record.key,
        ...toByteArray(record.key.length, 4),
        ...record.value,
        ...toByteArray(record.value.length, 4),
      ])
    );
  }

  do_addr_humanize(source: Region, destination: Region): Region {
    if (source.str.length === 0) {
      throw new Error('Empty address.');
    }

    let result = this.backend.backend_api.human_address(source.data);

    destination.write_str(result);

    // TODO: add error handling; -- 0 = success, anything else is a pointer to an error message
    return new Region(this.exports.memory, 0);
  }

  do_addr_canonicalize(source: Region, destination: Region): Region {
    let source_data = source.str;

    if (source_data.length === 0) {
      throw new Error('Empty address.');
    }

    let result = this.backend.backend_api.canonical_address(source_data);

    destination.write(result);

    return new Region(this.exports.memory, 0);
  }

  do_addr_validate(source: Region): Region {
    if (source.str.length === 0) {
      throw new Error('Empty address.');
    }

    if (source.str.length > MAX_LENGTH_HUMAN_ADDRESS) {
      throw new Error(`Address too large: ${source.str}`);
    }

    const canonical = this.bech32.fromWords(
      this.bech32.decode(source.str).words
    );

    if (canonical.length === 0) {
      throw new Error('Invalid address.');
    }

    const human = this.bech32.encode(
      this.backend.backend_api.bech32_prefix,
      this.bech32.toWords(canonical)
    );
    if (human !== source.str) {
      throw new Error('Invalid address.');
    }
    return new Region(this.exports.memory, 0);
  }

  // Verifies message hashes against a signature with a public key, using the secp256k1 ECDSA parametrization.
  // Returns 0 on verification success, 1 on verification failure
  do_secp256k1_verify(hash: Region, signature: Region, pubkey: Region): number {
    const isValidSignature = ecdsaVerify(
      signature.data,
      hash.data,
      pubkey.data
    );

    if (isValidSignature) {
      return 0;
    } else {
      return 1;
    }
  }

  do_secp256k1_recover_pubkey(
    msgHash: Region,
    signature: Region,
    recover_param: number
  ): Region {
    const pub = ecdsaRecover(
      signature.data,
      recover_param,
      msgHash.data,
      false
    );
    return this.allocate_bytes(pub);
  }

  // Verifies a message against a signature with a public key, using the ed25519 EdDSA scheme.
  // Returns 0 on verification success, 1 on verification failure
  do_ed25519_verify(
    message: Region,
    signature: Region,
    pubkey: Region
  ): number {
    if (message.length > MAX_LENGTH_ED25519_MESSAGE) return 1;
    if (signature.length > MAX_LENGTH_ED25519_SIGNATURE) return 1;
    if (pubkey.length > EDDSA_PUBKEY_LEN) return 1;

    const sig = Buffer.from(signature.data).toString('hex');
    const pub = Buffer.from(pubkey.data).toString('hex');
    const msg = Buffer.from(message.data).toString('hex');
    const _signature = global.eddsa().makeSignature(sig);
    const _pubkey = global.eddsa().keyFromPublic(pub);

    const isValidSignature = global.eddsa().verify(msg, _signature, _pubkey);

    if (isValidSignature) {
      return 0;
    } else {
      return 1;
    }
  }

  // Verifies a batch of messages against a batch of signatures with a batch of public keys,
  // using the ed25519 EdDSA scheme.
  // Returns 0 on verification success (all batches verify correctly), 1 on verification failure
  do_ed25519_batch_verify(
    messages_ptr: Region,
    signatures_ptr: Region,
    public_keys_ptr: Region
  ): number {
    let messages = decodeSections(messages_ptr.data);
    let signatures = decodeSections(signatures_ptr.data);
    let publicKeys = decodeSections(public_keys_ptr.data);

    if (
      messages.length === signatures.length &&
      messages.length === publicKeys.length
    ) {
      // Do nothing, we're good to go
    } else if (
      messages.length === 1 &&
      signatures.length == publicKeys.length
    ) {
      const repeated = [];
      for (let i = 0; i < signatures.length; i++) {
        repeated.push(...messages);
      }
      messages = repeated;
    } else if (
      publicKeys.length === 1 &&
      messages.length == signatures.length
    ) {
      const repeated = [];
      for (let i = 0; i < messages.length; i++) {
        repeated.push(...publicKeys);
      }
      publicKeys = repeated;
    } else {
      throw new Error(
        'Lengths of messages, signatures and public keys do not match.'
      );
    }

    if (
      messages.length !== signatures.length ||
      messages.length !== publicKeys.length
    ) {
      throw new Error(
        'Lengths of messages, signatures and public keys do not match.'
      );
    }

    for (let i = 0; i < messages.length; i++) {
      const message = Buffer.from(messages[i]).toString('hex');
      const signature = Buffer.from(signatures[i]).toString('hex');
      const publicKey = Buffer.from(publicKeys[i]).toString('hex');

      const _signature = global.eddsa().makeSignature(signature);
      const _publicKey = global.eddsa().keyFromPublic(publicKey);

      let isValid: boolean;
      try {
        isValid = global.eddsa().verify(message, _signature, _publicKey);
      } catch (e) {
        console.log(e);
        return 1;
      }

      if (!isValid) {
        return 1;
      }
    }

    return 0;
  }

  do_debug(message: Region) {
    this.debugMsgs.push(message.read_str());
  }

  do_query_chain(request: Region): Region {
    const resultPtr = this.backend.querier.query_raw(request.data, 100000);

    let region = this.allocate(resultPtr.length);
    region.write(resultPtr);
    return region;
  }

  do_abort(message: Region) {
    throw new Error(`abort: ${message.read_str()}`);
  }
}

function decodeSections(
  data: Uint8Array | number[]
): (number[] | Uint8Array)[] {
  let result: (number[] | Uint8Array)[] = [];
  let remainingLen = data.length;

  while (remainingLen >= 4) {
    const tailLen = toNumber([
      data[remainingLen - 4],
      data[remainingLen - 3],
      data[remainingLen - 2],
      data[remainingLen - 1],
    ]);

    const section = data.slice(remainingLen - 4 - tailLen, remainingLen - 4);
    result.push(section);

    remainingLen -= 4 + tailLen;
  }

  result.reverse();
  return result;
}
