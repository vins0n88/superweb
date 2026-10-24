// Test helper: a tiny Ethereum JSON-RPC node (not a test file itself).
import http from 'node:http';
import { ethers } from 'ethers';

const abi = ethers.AbiCoder.defaultAbiCoder();
/** eth_call answers: symbol()/decimals() from `tokens` (by contract address), 25 units otherwise. */
function callResult({ to, data }, tokens) {
  const t = tokens[ethers.getAddress(to)];
  const sel = String(data).slice(0, 10);
  if (sel === '0x95d89b41') return t ? abi.encode(['string'], [t.symbol]) : '0x';
  if (sel === '0x313ce567') return t ? abi.encode(['uint8'], [t.decimals]) : '0x';
  return `0x${(25n * 10n ** 6n).toString(16).padStart(64, '0')}`;
}

/** A tiny Ethereum JSON-RPC node: enough for ethers to estimate, sign, and broadcast. */
export async function fakeChain(chainId, { tokens = {} } = {}) {
  const sent = [];
  const balance = 10n ** 18n; // 1 ETH
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msgs = [].concat(JSON.parse(body));
      const out = msgs.map(({ id, method, params }) => {
        if (method === 'eth_sendRawTransaction') {
          sent.push(ethers.Transaction.from(params[0]));
          return { jsonrpc: '2.0', id, result: sent.at(-1).hash };
        }
        const result = {
          eth_chainId: `0x${chainId.toString(16)}`, net_version: String(chainId), eth_blockNumber: '0x10',
          eth_getBalance: `0x${balance.toString(16)}`, eth_getTransactionCount: '0x0', eth_estimateGas: '0x5208',
          eth_gasPrice: '0x3b9aca00', eth_maxPriorityFeePerGas: '0x3b9aca00',
          eth_getBlockByNumber: { number: '0x10', baseFeePerGas: '0x3b9aca00', hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'0'.repeat(64)}`, timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: `0x${'0'.repeat(40)}`, extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', transactions: [] },
        }[method] ?? (method === 'eth_call' ? callResult(params[0], tokens) : undefined);
        return result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } } : { jsonrpc: '2.0', id, result };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { url: `http://127.0.0.1:${port}`, sent, close: () => { server.closeAllConnections(); server.close(); } };
}
