// Built-ins that sendspin-js uses without a feature check and that Cast firmware
// running the legacy build can lack. Everything else it either checks for first
// (AudioDecoder, outputLatency, getOutputTimestamp, mediaSession) or is old enough.

// Chrome 71
if (typeof globalThis === "undefined") {
  (window as any).globalThis = window;
}

// Chrome 67 brought BigInt and with it DataView.getBigInt64. sendspin-js reads each
// audio chunk's 64-bit timestamp with it and passes the result through Number(), so a
// Number serves the same purpose: microsecond timestamps stay exact up to 2^53.
if (typeof DataView.prototype.getBigInt64 !== "function") {
  Object.defineProperty(DataView.prototype, "getBigInt64", {
    configurable: true,
    writable: true,
    value(this: DataView, byteOffset: number, littleEndian?: boolean): number {
      const high = this.getInt32(
        byteOffset + (littleEndian ? 4 : 0),
        littleEndian,
      );
      const low = this.getUint32(
        byteOffset + (littleEndian ? 0 : 4),
        littleEndian,
      );
      return high * 0x100000000 + low;
    },
  });
}
