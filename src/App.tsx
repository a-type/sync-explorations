import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from 'react';
import './App.css';
import { SyncClient } from './sync';

const ClientContext = createContext<SyncClient<Value>>(null as any);
const useClient = () => useContext(ClientContext);

type Value = {
	value: number;
	transient?: true;
};

const topic = 'test';
const seed = {
	a: { value: 0 },
};
const clientA = new SyncClient<Value>({ topic, seed, identity: 'clientA' });
const clientB = new SyncClient<Value>({ topic, identity: 'clientB' });
const server = new SyncClient<Value>({
	topic,
	identity: 'server',
	isServer: true,
});

const peers = {
	clientA,
	clientB,
	server,
};
(window as any).peers = peers;

function useObject(client: SyncClient<Value>, id: string) {
	return useSyncExternalStore(
		(cb) => {
			client.on(`change:${id}`, cb);
			return () => void client.off(`change:${id}`, cb);
		},
		() => client.get(id) as Value
	);
}

// don't judge me.
function deepEqual(...objs: any[]) {
	for (let i = 0; i < objs.length; i++) {
		for (let j = 0; j < objs.length; j++) {
			if (!objs[i] || !objs[j]) {
				return false;
			}
			if (
				JSON.stringify(objs[i], Object.keys(objs[i]).sort()) !==
				JSON.stringify(objs[j], Object.keys(objs[j]).sort())
			) {
				return false;
			}
		}
	}
	return true;
}

function ConsistencyStatus() {
	useObject(clientA, 'a');
	useObject(clientB, 'a');
	useObject(server, 'a');
	const [_, setNonce] = useState(0);
	const forceUpdate = useCallback(() => setNonce((_) => _ + 1), []);
	useEffect(() => {
		clientA.on('connected', forceUpdate);
		clientB.on('connected', forceUpdate);
		server.on('connected', forceUpdate);
		return () => {
			clientA.off('connected', forceUpdate);
			clientB.off('connected', forceUpdate);
			server.off('connected', forceUpdate);
		};
	}, [forceUpdate]);

	// raw objects are referentially stable so I can't
	// just use sync external store to compare them
	const clientAObject = clientA.getRaw('a');
	const clientBObject = clientB.getRaw('a');
	const serverObject = server.getRaw('a');

	const consistent =
		deepEqual(
			clientAObject?.history,
			clientBObject?.history,
			serverObject?.history
		) &&
		deepEqual(clientAObject?.base, clientBObject?.base, serverObject?.base);

	return (
		<div style={{ color: consistent ? 'green' : 'red' }}>
			{consistent ? 'Consistent' : 'Inconsistent'}
		</div>
	);
}

function ObjectView({ id }: { id: string }) {
	const client = useClient();
	const object = useObject(client, id);
	function decrement() {
		client.set(id, 'value', object.value - 1);
	}
	function increment() {
		client.set(id, 'value', object.value + 1);
	}
	function addTransient() {
		client.set(id, 'transient', true);
	}
	function deleteTransient() {
		client.set(id, '-transient');
	}

	const { history, peerAcks: peerVersions } = client.getRaw(id)!;

	return (
		<details open>
			<summary>
				<div>{JSON.stringify(object)}</div>
				<button onClick={decrement}>-</button>
				<button onClick={increment}>+</button>
				<br />
				<button onClick={addTransient}>add transient</button>
				<button onClick={deleteTransient}>delete transient</button>
			</summary>
			<ol>
				{Object.keys(history.versions)
					.sort()
					.map((key) => (
						<li key={key}>
							<div>{key}</div>
							<div>{JSON.stringify(history.versions[key].patches)}</div>
							<div>parents: {history.versions[key].parents.join(',')}</div>
							<div>children:</div>
							<ul>
								{history.versions[key].children.map((c) => (
									<li key={c}>{c}</li>
								))}
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
			client.on('connected', cb);
			client.on('disconnected', cb);
			return () => {
				client.off('connected', cb);
				client.off('disconnected', cb);
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
					display: 'flex',
					flexDirection: 'column',
					gap: '4px',
					border: '1px solid black',
					padding: '12px',
					width: '20vw',
					height: '100%',
				}}
			>
				{client.identity}
				{client.identity !== 'server' && (
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
		<div
			style={{
				display: 'flex',
				flexDirection: 'row',
				gap: '8px',
				height: '80vh',
			}}
		>
			<ConsistencyStatus />
			<ClientView client={clientA} />
			<ClientView client={clientB} />
			<ClientView client={server} />
		</div>
	);
}
