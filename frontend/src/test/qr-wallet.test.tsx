import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {QrWalletButton} from '../QrWalletButton';
const connect=vi.hoisted(()=>vi.fn());
vi.mock('../qr-wallet',()=>({connectQrWallet:connect}));
describe('QR wallet entry',()=>{
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
