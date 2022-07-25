# How Aglio syncs changes between devices and realtime users

The client works offline for as long as it likes before it ever learns of the server. A user only connects to the server after they've signed up for syncing.

Data is synced in the scope of a Plan. For the initial app, a Plan just owns a Grocery List.

The server keeps a list of unique client IDs for every client which has access to a particular Plan's data.

The server tries to keep a patch history for every object all the way back to each oldest known client version. However, to save on space, if the server detects a client hasn't joined in a while, it will forget the client and recompute the history to the new oldest version.

Keeping this history means that whenever data is stored, it's in the form of a `base` object and a list of `version`s.

```
+-----------------------------+--------------------------------+
| Base                        | Version                        |
+-----------------------------+--------------------------------+
| {                           |
|   "name": "Grocery List",   |
|   "items": [                |
|     {                       |
|       "name": "Milk",       |    (not the final shape of these)
|       "quantity": 1         |
|     },                      |
|   ]                         |
| }                           |
+-----------------------------+--------------------------------+
                              | {                              |
                              |    "range": "items.0.quantity" |
                              |    "value": 2                  |
                              | }                              |
                              +--------------------------------+
                              | {                              |
                              |    "range": "items.1"          |
                              |    "value": { ... etc }        |
                              | }                              |
                              +--------------------------------+
```

When a client connects to the server, it sends a `hello` message. If the server has never seen this client before, it will send the whole object and history to that client.

## Tricky scenarios

Suppose we have two clients which talk to the server like so...

```
+-----------------------------+--------------------------------+-----------------------------+
| Client 1                    | Client 2                       | Server                      |
+-----------------------------+--------------------------------+-----------------------------+
| ---- OFFLINE ----           | ---- OFFLINE ----              |                             |
| Set item A qty to 1    [a1] |                                |                             |
| Set item B qty to 3    [a2] |                                |                             |
| Set item A qty to 4    [a3] |                                |                             |
| ---- ONLINE ----            |                                |                             |
| Sends all changes to server |                                | Got changes from client 1   |
|                             |                                | Client 1 is at "a0"         |
|                             |                                | Client 2 is at "a0"         |
|                             |                                | base: {}                    |
|                             |                                | patches: [                  |
|                             |                                |   {                         |
|                             |                                |     "ver":   "a1"           |
|                             |                                |     "range": "A.qty"        |
|                             |                                |     "value": 1              |
|                             | Set item A qty to 2       [b1] |   }                         |
|                             | Set item B qty to 8       [b2] |   {                         |
|                             | Create item C, qty 1      [b3] |     "ver":   "a2"           |
|                             |                                |     "range": "B.qty"        |
|                             |                                |     "value": 3              |
|                             |                                |   },                        |
|                             |                                |   {                         |
|                             |                                |     "ver":   "a3"           |
|                             |                                |     "range": "A.qty"        |
|                             |                                |     "value": 4              |
|                             |                                |   }                         |
|                             |                                | ]                           |
|                             |                                | Client 1 is at "a3"         |
|                             |                                |                             |
| What should I keep?         |                                | Everything back to a0       |
| Ok.                         |                                |                             |
| ---- OFFLINE ----           |                                |                             |
|                             | ---- ONLINE ----               |                             |
|                             |  Hi                            | Hey, here's new changes     |
|                             |                                | a1, a2, a3                  |
|                             |                                |                             |
|                             |  Ok here's my changes          | Got changes from client 2   |
|                             |                                | Client 1 is at "a3"         |
|                             |                                | Client 2 is at "a0"         |
|                             |                                | base: {}                    |
|                             |                                | patches: [                  |
|                             |                                |   {                         |
|                             |                                |     "ver":   "a1"           |
|                             |                                |     "range": "A.qty"        |
|                             |                                |     "value": 1              |
|                             |                                |   },                        |
|                             |                                |   {                         |
|                             |                                |     "ver":   "b1"           |
|                             |                                |     "range": "A.qty"        |
|                             |                                |     "value": 2              |
|                             |                                |   },                        |
|                             |                                |   {                         |
|                             |                                |     "ver":   "a2"           |
|                             |                                |     "range": "B.qty"        |
|                             |                                |     "value": 3              |
|                             |                                |   },                        |
|                             |                                |   {                         |
|                             |                                |     "ver":   "b2"           |
|                             |                                |     "range": "B.qty"        |
|                             |                                |     "value": 8              |
|                             |                                |   },                        |
|                             |                                |   {                         |
|                             |                                |     "ver":   "a3"           |
|                             |                                |     "range": "A.qty"        |
|                             |                                |     "value": 4              |
|                             |                                |   },                        |
|                             |                                |   {                         |
|                             |                                |     "ver":   "b3"           |
|                             |                                |     "range": "C"            |
|                             |                                |     "value": { qty: 1}      |
|                             |                                |   }                         |
|                             |                                |                             |
|                             |                                |                             |
|                             |                                | client 1 is at "a3"         |
|                             |                                | client 2 is at "b3"         |
|                             |                                |                             |
|                             |                                | Looks like Client 1 needs   |
|                             |                                | to rewind to "a1"           |
|                             |                                |                             |
|                             |                                | client 1 is at "a1"         |
| --- ONLINE ----             |                                |                             |
|  Hi                         |                                | Hey, here's new changes     |
|                             |                                | b1, a2, b2, a3, b3          |
| Ok, I already have          |                                |                             |
| a2 and a3 but I'll          |                                |                             |
| add b1, b2, b3              |                                |                             |
|                             |                                |                             |
```

In this scenario, clients 1 and 2 make offline changes which fork the history into 2 branches.
Since 1 connects first, it sets the initial history. Then it disconnects, thinking its
own history is the authoritative one. The server records that 1 has reached "a3" version.

2 then connects and the server lets it know about 1's changes. But 2 also was changing history
from the last known synced point, a0. So 2 must merge the patches from the a-branch history
into its b-branch history. It interleaves them in an arbitrary order starting from their
common parent. [[NOTE: Interleaving? Arbitrary? Is that OK?]]. The merge algorithm will combine this
interleaved history into a final view in memory.

Meanwhile 2 pushes its own b-branch changes to the server. The server does the exact same
interleaving in the same order. The server records that 2 has reached "b3" version.

Now the server also realizes that history has diverged for client 1. In order to get the whole history
it needs to go back to the common ancestor at "a1". So it resets client 1 to there.

> **Note:** this model is outdated. Now the server (and each client) just keeps acks of every seen version for every client. No 'rewinding' is needed.

Now when client 1 reconnects, it will get the history since its divergence - even though that
history includes some of its own patches. It will just discard duplicates.

At the end of this, both 1 and 2 will be at "b3". Since these are the only 2 clients the server
knows about, it can flatten and discard history up to b3.

### Another wrinkle

Suppose another client connects later on. In this case, it will not have a common
history ancestor at all! The server will respond that it can't sync with that client.
The client will have to decide whether to reset itself to the server's world or
not sync.
IRL this case is like if you used the app offline on one device, signed up for sync, then used it offline without signing in on another device. You've got 2 different grocery lists. It's probably fine that you have to choose one.

### What about 3? Does it generalize?

Pretty sure yeah.

### How do clients get informed of historical changes to objects they haven't changed locally?

In the above examples, it's all about 1 object the clients are both modifying. But what
if 1 makes a change to a different object that 2 didn't change?

The server will still know 2's latest version for that object. When 2 connects it can
compare versions of all objects to 2's last knowns and send over histories for all
the ones that differ.

### How do clients learn about created objects?

Same thing - the server will see that the client doesn't have a version for the object,
so it will send the whole history. That's also how all new clients bootstrap.

### How does the client know which patches to send to the server?

Well, it's not illustrated here, but the client is actually keeping an "ack list" of
versions for the server, too. In fact the client views the server basically the same
as the server views the client.

The main difference between server and client is that the server is the authority
on which clients are part of the network, and rebroadcasts peer activity.

### What does a client do before it ever sees a server?

Perhaps if a client has never seen a peer, it should just not store history. When it does see a peer,
it will have to choose whether to take the peer's history or push its own, if the peer has
a different history. Their histories won't otherwise be reconcilable from parents as there
are no common ancestors.

# Notes after testing implementation

It looks like merge patches are needed - or else some smarter way of representing history than a list.

If client 2 inserts a patch into history between two patches from client 1, the server's view of client 1's
point in history doesn't change, so it won't inform client 1 of client 2's insertion.

Instead, client 2's changes should branch, and the server should see the branch and create a merge when history is
synced up to date again, then push that merge to both clients.

Can this happen for each 1-patch branch length? Like we just keep merging each branched patch into its sibling?

```
a0

a1->a0  b1->a0

c2->[a1, b1]

a3->c2

a4->a3  b4->a3

c5->[a4, b4]
```

Like that?

Could it still be stored in a list - just a list of lists?

```
[
  [a0],
  [a1, b1],
  [c2],
  [a3, b3],
  [a4, b4],
  [c5]
]
```

Does it generalize to n? Seems like it should.

```
[
  [a0],
  [a1, b1, c1],
  [d2],
  [a3, b3],
  [d4],
  [a5],
  [b6, c6],
  [d7]
]
```

Suppose the sequence `b1<-b2<-b3` comes in that order in the examples above. How does
the client know how to interleave the patches if there's now a merge patch between
b1 and b2?

Ok, what does a merge patch even represent? It wouldn't have its own changeset? Or would it have a merged version of its parents changesets?

Do we need a merge patch? Or just to store siblings in an array?

Answer: merge patch has value because that's how we solve the original problem of this section: informing a client another client inserted something
into history behind where they are.

But it doesn't, actually... if I make a merge for [a1, b1] as [c2], it doesn't tell client a that b1 exists...

### I'd forgotten about history rewind

When a client adds a patch back in history, the server rewinds other clients to the parent so
they replay the rest of the history.

### What if we store history as a map?

```
{
  a0: { parent: null, patches: [...] },
  a1: { parent: a0, patches: [...] },
  ...
}
```

Then traversal from start to finish would be quite hard.

What if we went the other way around for storage...

```
{
  a0: { children: ['a1', 'b1'], patches: [...] },
  a1: { children: ['c2'], patches: [...] },
  b1: { children: ['c2'], patches: [...] },
  c2: { children: [], patches: [...] },
}
```

# Notes on collapse (22/7/24)

Collapsing history is important to keep storage down on devices.

Who collapses history?

Prerequisites for collapsing:

A 'bubble' (a self-enclosed group of connected nodes which have a single start and end)
Every version in this bubble must be acknowledged by every known peer in the entire network.

The server is an obvious candidate for collapsing since it knows every peer by definition. If a client has never contacted the server, it is not part of the network.

However this presents a challenge... we have to buffer collapse events because a server may collapse history when not all clients are online, and this is a destructive action, so it can't be replayed. Not the worst thing in the world, we add a "collapses" to the history, and we have clients ack collapses at which point they are finally cleaned up.

Or... we could have clients collapse their own histories independently. To even start to do this we'd need to send peer history positions to clients. But first there is an edge case to explore...

Suppose Client 1 connects to Server. Client 1 has a linear history. Once it's informed Server of this history, from its view, all clients have seen every node, and it can collapse the entire history. Cool?

Well, actually... yeah. Suppose Client 2 also existed, but it had only appeared after Client 1 went offline - so Client 1 never knew about Client 2. Client 2 added its own branching history, informed Server, then went offline itself.

When Client 1 connects now, it tells Server about its new history. Server answers back that it acks the history, but there's a new Client 2 which has not acked. It also tells Client 1 about Client 2's branch and provides a merge version.

Now Client 1 sees that Server has acked its whole linear history, but it adds a new Client 2 ack list which has not. It can't collapse its history.

No client will ever collapse its history offline after it has connected to the server for the first time either - because the server counts as a peer who hasn't acked the nodes.

So this is correct! We just have to synchronize all known peer acks from the server.

## But how do we do that lol

Seems like another chicken-egg acking problem. How does Server know Client 1 hasn't seen Client 2? And after Client 1 has seen Client 2, how does Server know which Client 2 acks Client 1 knows about? Do we need to ack acks now?

A brute force way would be to send every ack list of every peer whenever you connect. Since a version can never be unacknowledged, you can safely merge the list into your own and you have the most complete list possible in the current situation. These lists shouldn't be too large, and are pruned along with history over time.

To save network traffic in the good cases, we could also exchange hashes of ack lists. When a client connects it sends `peerId: ackHash` combos to the server. If the server's hash doesn't match, it replies with the full list. If a peer ID is missing, it also replies with the full list.

I like that better I think. Not too complicated, but still relatively efficient for the common case. For example, a client will send its own ack hash, and the server will never dispute that. But it could be an over-optimization if the lists are frequently incorrect.

The new protocol for connecting to the server would look like this...

```
Client                                Server
------                                ------
Hello ->
- For each object I have
  - Peer ack list hashes
  - Changes you haven't acked
  - If you aren't even in an
    ack list, the whole thing

                                      I add any new objects you sent
                                      which I haven't seen before.
                                      I merge in any changes which are
                                      new to me.

                                      <- Hello Back
                                      - For each object I have
                                        - Peer ack list hashes
                                        - If your ack list hash differed,
                                          I send the whole list
                                        - Changes you haven't acked
                                        - If you aren't even in an
                                          ack list, the whole thing

I add any new objects you sent
which I haven't seen before.
I merge in any changes which are
new to me.
I merge in any ack lists which
you sent based on hashes.
I compare the new hashes to
the hashes you sent me.

Hello Back Back ->
- For any ack lists whose final
  hashes weren't the same as
  the hashes you sent me with
  your edits, I send you my
  full ack list.
                                     I merge in any ack lists you sent me

                                     <- Final Ack of all that

Now I can prune history!             Now I can prune history!
```

# How do you delete objects?

uuugh I don't know! stop asking!

ok, so deletion should probably be a patch just like anything else.

Ideally I'd prefer for a delete patch to always be sorted before any other adjacent patches. Not sure how to do that effectively.

Until the delete is confirmed by all peers, the data will remain with a flag on it.
