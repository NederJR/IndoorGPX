// Conexão com rolo inteligente via Bluetooth LE usando o padrão FTMS
// (Fitness Machine Service), suportado pelo ThinkRider XX Pro.

export interface TrainerData {
  speedKmh?: number;
  cadence?: number;
  power?: number;
  heartRate?: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

const FTMS_SERVICE = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const CONTROL_POINT = 0x2ad9;

const OP_REQUEST_CONTROL = 0x00;
const OP_START_OR_RESUME = 0x07;
const OP_SET_SIMULATION = 0x11;
const OP_RESPONSE = 0x80;

const RESPONSE_TIMEOUT_MS = 2000;
const RECONNECT_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decodifica a característica Indoor Bike Data (0x2AD2). */
export function parseIndoorBikeData(view: DataView): TrainerData {
  const out: TrainerData = {};
  if (view.byteLength < 2) return out;
  const flags = view.getUint16(0, true);
  let o = 2;
  const has = (n: number) => o + n <= view.byteLength;

  // Bit 0 = "More Data": quando 0, a velocidade instantânea está presente.
  if (!(flags & 0x0001)) {
    if (!has(2)) return out;
    out.speedKmh = view.getUint16(o, true) / 100;
    o += 2;
  }
  if (flags & 0x0002) o += 2; // velocidade média
  if (flags & 0x0004) {
    if (!has(2)) return out;
    out.cadence = view.getUint16(o, true) / 2;
    o += 2;
  }
  if (flags & 0x0008) o += 2; // cadência média
  if (flags & 0x0010) o += 3; // distância total
  if (flags & 0x0020) o += 2; // nível de resistência
  if (flags & 0x0040) {
    if (!has(2)) return out;
    out.power = view.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0080) o += 2; // potência média
  if (flags & 0x0100) o += 5; // energia
  if (flags & 0x0200) {
    if (!has(1)) return out;
    out.heartRate = view.getUint8(o);
  }
  return out;
}

export class Trainer {
  onData?: (data: TrainerData) => void;
  onStatus?: (status: ConnectionStatus, message?: string) => void;

  private device?: BluetoothDevice;
  private controlPoint?: BluetoothRemoteGATTCharacteristic;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingResponse?: { opcode: number; resolve: (result: number | null) => void };
  private manualDisconnect = false;
  private _status: ConnectionStatus = 'disconnected';

  get status(): ConnectionStatus {
    return this._status;
  }

  get name(): string {
    return this.device?.name ?? 'Rolo';
  }

  private setStatus(status: ConnectionStatus, message?: string) {
    this._status = status;
    this.onStatus?.(status, message);
  }

  async connect(): Promise<void> {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }, { namePrefix: 'Thinkrider' }, { namePrefix: 'THINK' }],
      optionalServices: [FTMS_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.manualDisconnect = false;
    this.setStatus('connecting');
    try {
      await this.setup();
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('disconnected', String(err));
      throw err;
    }
  }

  disconnect() {
    this.manualDisconnect = true;
    this.device?.gatt?.disconnect();
  }

  /** Envia a inclinação (e parâmetros de rolamento/vento) para o rolo em modo simulação. */
  setSimulation(gradePct: number, crr: number, windCoefficient: number): Promise<void> {
    const buf = new DataView(new ArrayBuffer(7));
    buf.setUint8(0, OP_SET_SIMULATION);
    buf.setInt16(1, 0, true); // velocidade do vento (0,001 m/s)
    buf.setInt16(3, Math.round(gradePct * 100), true); // inclinação (0,01 %)
    buf.setUint8(5, clampByte(Math.round(crr * 10000))); // Crr (0,0001)
    buf.setUint8(6, clampByte(Math.round(windCoefficient * 100))); // Cw (0,01 kg/m)
    return this.command(new Uint8Array(buf.buffer));
  }

  private async setup() {
    const server = await this.device!.gatt!.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);

    const bikeData = await service.getCharacteristic(INDOOR_BIKE_DATA);
    bikeData.addEventListener('characteristicvaluechanged', this.handleBikeData);
    await bikeData.startNotifications();

    this.controlPoint = await service.getCharacteristic(CONTROL_POINT);
    this.controlPoint.addEventListener('characteristicvaluechanged', this.handleControlResponse);
    await this.controlPoint.startNotifications();

    await this.command(new Uint8Array([OP_REQUEST_CONTROL]));
    await this.command(new Uint8Array([OP_START_OR_RESUME]));
  }

  /** Comandos GATT não podem ser sobrepostos, então são enfileirados. */
  private command(bytes: Uint8Array): Promise<void> {
    const run = async () => {
      const cp = this.controlPoint;
      if (!cp || this._status === 'disconnected') return;
      const response = new Promise<number | null>((resolve) => {
        this.pendingResponse = { opcode: bytes[0], resolve };
        setTimeout(() => resolve(null), RESPONSE_TIMEOUT_MS);
      });
      await cp.writeValueWithResponse(bytes as Uint8Array<ArrayBuffer>);
      const result = await response;
      this.pendingResponse = undefined;
      if (result === null) console.warn(`FTMS: sem resposta para opcode 0x${bytes[0].toString(16)}`);
      else if (result !== 0x01) console.warn(`FTMS: opcode 0x${bytes[0].toString(16)} retornou ${result}`);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch((err) => console.warn('FTMS: falha no comando', err));
    return next;
  }

  private handleBikeData = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (value) this.onData?.(parseIndoorBikeData(value));
  };

  private handleControlResponse = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value || value.byteLength < 3 || value.getUint8(0) !== OP_RESPONSE) return;
    const pending = this.pendingResponse;
    if (pending && pending.opcode === value.getUint8(1)) pending.resolve(value.getUint8(2));
  };

  private handleDisconnect = async () => {
    this.controlPoint = undefined;
    if (this.manualDisconnect) {
      this.setStatus('disconnected');
      return;
    }
    this.setStatus('reconnecting');
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      await sleep(2000);
      if (this.manualDisconnect) break;
      try {
        await this.setup();
        this.setStatus('connected');
        return;
      } catch {
        // tenta novamente
      }
    }
    this.setStatus('disconnected', 'Conexão com o rolo perdida.');
  };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n));
}
