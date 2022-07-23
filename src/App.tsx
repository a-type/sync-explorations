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
  b: { value: 0 }
};
const clientA = new SyncClient<Value>({ topic, seed, identity: "clientA" });
const clientB = new SyncClient<Value>({ topic, seed, identity: "clientB" });
const server = new SyncClient<Value>({ topic, seed, identity: "server" });

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

  const { patches, peerVersions } = client.getRaw(id)!;

  return (
    <details open>
      <summary>
        <button onClick={decrement}>-</button>
        {JSON.stringify(object)}
        <button onClick={increment}>+</button>
      </summary>
      <ol>
        {patches.map((p) => (
          <li key={p.version}>
            {p.version} (parent: {p.parent})
          </li>
        ))}
      </ol>
      <div>
        {Object.entries(peerVersions).map(([ident, version]) => (
          <div key={ident}>
            I see {ident} at {version}
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
          padding: "12px"
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
    <div style={{ display: "flex", flexDirection: "row", gap: "8px" }}>
      <ClientView client={clientA} />
      <ClientView client={clientB} />
      <ClientView client={server} />
    </div>
  );
}
