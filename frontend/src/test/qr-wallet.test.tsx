import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {QrWalletButton} from '../QrWalletButton';
import {normalizeWalletSessionEvent,normalizeWalletSessionUpdate} from '../qr-wallet';
const connect=vi.hoisted(()=>vi.fn());
vi.mock('../qr-wallet',async importOriginal=>({...await importOriginal<typeof import('../qr-wallet')>(),connectQrWallet:connect}));
describe('QR wallet entry',()=>{
 it('binds session updates to the approved topic and Bloch L2 namespace',()=>{
  const topic='approved';
  expect(normalizeWalletSessionEvent({topic:'other',params:{chainId:'eip155:84001',event:{name:'accountsChanged',data:['0x'+'12'.repeat(20)]}}},topic)).toBeNull();
  expect(normalizeWalletSessionEvent({topic,params:{chainId:'eip155:84001',event:{name:'accountsChanged',data:['0x'+'12'.repeat(20)]}}},topic)).toEqual({disconnect:false,event:'accountsChanged',value:['0x'+'12'.repeat(20)],address:'0x'+'12'.repeat(20)});
  expect(normalizeWalletSessionEvent({topic,params:{chainId:'eip155:84001',event:{name:'chainChanged',data:'84001'}}},topic)).toEqual({disconnect:false,event:'chainChanged',value:'0x14821'});
 for(const message of [
   {topic,params:{chainId:'eip155:1',event:{name:'chainChanged',data:'0x1'}}},
   {topic,params:{chainId:'eip155:84001',event:{name:'accountsChanged',data:[]}}},
   {topic,params:{chainId:'eip155:84001',event:{name:'chainChanged',data:'0x1'}}},
  ])expect(normalizeWalletSessionEvent(message,topic)?.disconnect).toBe(true);
  const current='0x'+'12'.repeat(20),next='0x'+'34'.repeat(20);
  expect(normalizeWalletSessionUpdate({topic,params:{namespaces:{eip155:{accounts:['eip155:84001:'+current]}}}},topic,current)).toBeNull();
  expect(normalizeWalletSessionUpdate({topic,params:{namespaces:{eip155:{accounts:['eip155:84001:'+next]}}}},topic,current)).toEqual({disconnect:false,event:'accountsChanged',value:[next],address:next});
  expect(normalizeWalletSessionUpdate({topic,params:{namespaces:{eip155:{accounts:['eip155:1:'+next]}}}},topic,current)?.disconnect).toBe(true);
 });
 it('requests a session only after click and passes the approved provider',async()=>{
  const provider={request:vi.fn()},onConnect=vi.fn().mockResolvedValue(undefined);
  connect.mockResolvedValue({id:'postern-walletconnect',name:'Postern',provider});
  render(<QrWalletButton onConnect={onConnect} disabled={false}/>);
  expect(connect).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button',{name:/Connect with QR/}));
  await waitFor(()=>expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({provider})));
  expect(provider.request).not.toHaveBeenCalled();
 });
 it('cancels an outstanding connection and refuses late approval',async()=>{
  let resolve!:(value:unknown)=>void;
  connect.mockImplementation(()=>new Promise(r=>{resolve=r}));
  const onConnect=vi.fn(),disconnect=vi.fn();
  render(<QrWalletButton onConnect={onConnect} disabled={false}/>);
  await userEvent.click(screen.getByRole('button',{name:/Connect with QR/}));
  await userEvent.click(screen.getByRole('button',{name:'Cancel QR connection'}));
  resolve({provider:{disconnect}});
  await waitFor(()=>expect(disconnect).toHaveBeenCalled());
  expect(onConnect).not.toHaveBeenCalled();
 });
});
