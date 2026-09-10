import { ArrowUpRight, Blocks, Code2, GitBranch } from 'lucide-react';
import { ExternalLink } from './components';

const repo = 'https://github.com/tiagobeltraoacioli-sketch/postern-dex';

export default function Develop() {
  return (
    <div className="develop-page">
      <section className="develop-intro">
        <span className="badge">Build on Bloch</span>
        <h1>
          From local code
          <br />
          to open markets.
        </h1>
        <p>
          Explore the DEX, build with EVM and Solana tooling, and follow the work connecting
          execution to the Bloch network.
        </p>
        <div className="develop-actions">
          <a className="button primary" href="https://blochprotocol.dev/#evm">
            Get the developer kit <ArrowUpRight size={17} />
          </a>
          <ExternalLink href={repo}>View DEX source</ExternalLink>
        </div>
      </section>
      <section aria-labelledby="integration-heading" className="develop-status">
        <div>
          <span className="badge">Release status · September 10, 2026</span>
          <h2 id="integration-heading">Explore today. Follow the integration.</h2>
        </div>
        <p>
          The trading interface uses sample data. Live swaps, liquidity deposits and withdrawals are
          not enabled. No production contract addresses are configured.
        </p>
        <dl className="release-grid">
          <div>
            <dt>Trade, pools & portfolio</dt>
            <dd>Interactive preview</dd>
          </div>
          <div>
            <dt>EVM & Solana developer kit</dt>
            <dd>Local software available</dd>
          </div>
          <div>
            <dt>Bloch settlement & bridge transfers</dt>
            <dd>Integration in progress</dd>
          </div>
          <div>
            <dt>Production DEX contracts</dt>
            <dd>Not deployed</dd>
          </div>
        </dl>
      </section>
      <section aria-label="Developer tools" className="develop-grid">
        <article>
          <Code2 size={25} />
          <h2>EVM development</h2>
          <p>
            Write Solidity contracts, run a local EVM, and test the DEX contracts with Foundry. The
            kit includes an installable CLI and a counter example.
          </p>
          <ExternalLink href="https://blochprotocol.dev/#evm">EVM software & setup</ExternalLink>
        </article>
        <article>
          <Blocks size={25} />
          <h2>Solana development</h2>
          <p>
            Build Solana programs with a local Agave validator and an example counter. SVM execution
            and settlement on Bloch are still under development.
          </p>
          <ExternalLink href="https://blochprotocol.io/build#svm">
            SVM software & setup
          </ExternalLink>
        </article>
        <article>
          <GitBranch size={25} />
          <h2>Bloch Bridge</h2>
          <p>
            Follow the bridge architecture and delivery status. Asset transfers will require a
            completed, reviewed settlement integration before they can open.
          </p>
          <ExternalLink href="https://blochbridge.pages.dev/">Explore Bloch Bridge</ExternalLink>
        </article>
      </section>
      <section className="develop-bottom">
        <article>
          <h2>Run the DEX locally</h2>
          <p>
            Use Node 24 for the frontend and Foundry v1.7.1 for the Solidity contracts. Start with
            the repository guide and its committed dependency lockfile.
          </p>
          <pre>
            <code>
              {
                'git clone https://github.com/tiagobeltraoacioli-sketch/postern-dex.git\ncd postern-dex/frontend\nnpm ci --ignore-scripts\nnpm run dev'
              }
            </code>
          </pre>
          <ExternalLink href={`${repo}/blob/main/frontend/README.md`}>
            Integration guide
          </ExternalLink>
        </article>
        <article>
          <h2>Help ship the next release.</h2>
          <p>
            Report reproducible issues, review the contract tests, or contribute developer examples.
            Bloch Builders is the starting point for contributing across the ecosystem.
          </p>
          <div className="develop-links">
            <ExternalLink href={`${repo}/issues`}>DEX issues & contributions</ExternalLink>
            <ExternalLink href="https://blochprotocol.dev/#builders">
              Join Bloch Builders
            </ExternalLink>
            <ExternalLink href={`${repo}/blob/main/docs/SECURITY-REVIEW-2026-09-08.md`}>
              Read the contract review
            </ExternalLink>
          </div>
          <p className="microcopy">
            The repository review is not an independent audit. A live release still needs verified
            deployment configuration, live data, transaction simulation and receipt handling.
          </p>
        </article>
      </section>
    </div>
  );
}
