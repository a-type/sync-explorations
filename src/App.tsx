import { createContext, useContext, useSyncExternalStore } from "react";
import "./App.css";
import { SyncClient } from "./sync";

const ClientContext = createContext<SyncClient<Value>>(null as any);
const useClient = () => useContext(ClientContext);

type Value = {
  value: number;
};

const topic = "test";
const seed = {
  a: { value: 0 },
};
const clientA = new SyncClient<Value>({ topic, seed, identity: "clientA" });
const clientB = new SyncClient<Value>({ topic, seed, identity: "clientB" });
const server = new SyncClient<Value>({ topic, seed, identity: "server", isServer: true });

const peers = {
  clientA,
  clientB,
  server
};

function ObjectView({ id }: { id: string }) {
  const client = useClient();
  const object = useSyncExternalStore(
    (cb) => {
      client.on(`change:${id}`, cb);
      return () => void client.off(`change:${id}`, cb);
    },
    () => client.get(id) as Value
  );
  function decrement() {
    client.set(id, "value", object.value - 1);
  }
  function increment() {
    client.set(id, "value", object.value + 1);
  }

  const { history, peerAcks: peerVersions } = client.getRaw(id)!;

  return (
    <details open>
      <summary>
        <button onClick={decrement}>-</button>
        {JSON.stringify(object)}
        <button onClick={increment}>+</button>
      </summary>
      <ol>
        {Object.keys(history.versions).sort().map((key) => (
          <li key={key}>
            <div>{key}</div>
            <div>{JSON.stringify(history.versions[key].patches)}</div>
            <div>parents: {history.versions[key].parents.join(',')}</div>
            <div>children:</div>
            <ul>
              {history.versions[key].children.map(c => <li key={c}>{c}</li>)}
            </ul>
          </li>
        ))}
      </ol>
      <div>
        <h3>My stats</h3>
        <div>Root: {history.root}</div>
        <div>Latest: {history.latest}</div>
      </div>
      <div>
        <h3>Peer stats</h3>
        {Object.entries(peerVersions).map(([ident, versions]) => (
          <div key={ident}>
            I see {ident} has {new Array(...versions).join(', ')}
          </div>
        ))}
      </div>
    </details>
  );
}

export function ClientView({ client }: { client: SyncClient<Value> }) {
  const ids = client.ids();

  const peers = useSyncExternalStore(
    (cb) => {
      client.on("connected", cb);
      client.on("disconnected", cb);
      return () => {
        client.off("connected", cb);
        client.off("disconnected", cb);
      };
    },
    () => client.peers
  );

  function toggleServerConnection() {
    if (!!peers.server) {
      client.disconnect(server);
    } else {
      client.connect(server);
    }
  }

  return (
    <ClientContext.Provider value={client}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          border: "1px solid black",
          padding: "12px",
          width: '20vw',
          height: '100%'
        }}
      >
        {client.identity}
        {client.identity !== "server" && (
          <div>
            <input
              type="checkbox"
              onChange={toggleServerConnection}
              checked={!!peers.server}
              value="online"
            />
            Online
          </div>
        )}
        {ids.map((id) => (
          <ObjectView id={id} key={id} />
        ))}
      </div>
    </ClientContext.Provider>
  );
}

export function App() {
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "8px", height: '80vh' }}>
      <ClientView client={clientA} />
      <ClientView client={clientB} />
      <ClientView client={server} />
    </div>
  );
}
