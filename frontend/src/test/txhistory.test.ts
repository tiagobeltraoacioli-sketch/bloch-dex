import { afterEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_LIMIT, historyKey, loadHistory, recordFinished } from '../mainnet/txhistory';

const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

describe('finished transaction history', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it('keeps the newest first, one per hash, up to the limit, per chain and account', () => {
    let list = loadHistory(1, ACCOUNT);
    for (let i = 0; i < HISTORY_LIMIT + 3; i++)
      list = recordFinished(1, ACCOUNT, list, { label: 'Swap', hash: hash(i), state: 'mined' });
    list = recordFinished(1, ACCOUNT, list, { label: 'Swap', hash: hash(5), state: 'failed' });
    const loaded = loadHistory(1, ACCOUNT);
    expect(loaded).toHaveLength(HISTORY_LIMIT);
    expect(loaded[0]).toMatchObject({ hash: hash(5), state: 'failed' });
    expect(loaded.filter((t) => t.hash === hash(5))).toHaveLength(1);
    expect(loadHistory(2, ACCOUNT)).toEqual([]);
  });
  it('drops malformed entries and survives a broken or blocked store', () => {
    localStorage.setItem(
      historyKey(1, ACCOUNT),
      '[{"label":"x","hash":"0x12","state":"mined"}, 5]',
    );
    expect(loadHistory(1, ACCOUNT)).toEqual([]);
    localStorage.setItem(historyKey(1, ACCOUNT), '{not json');
    expect(loadHistory(1, ACCOUNT)).toEqual([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const list = recordFinished(1, ACCOUNT, [], { label: 'Skim', hash: hash(1), state: 'mined' });
    expect(list).toHaveLength(1);
    expect(loadHistory(1, ACCOUNT)).toEqual([]);
  });
});
