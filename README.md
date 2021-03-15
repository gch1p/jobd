# jobd

**jobd** is a simple job queue daemon with persistent queue storage, written in
Node.JS. It uses a MySQL table as a storage backend (for queue input and output).

Currently, MySQL is the only supported storage type, but other backends might be
easily supported.

It is by design that jobd never adds nor deletes jobs from storage. It only
reads (when a certain request arrives) and updates them (during execution, when
job status changes). Succeeded or failed, your jobs are never lost.

jobd consists of 2 parts:

1. **jobd** is a "worker" daemon that reads jobs from the database, enqueues and
   launches them. There may be multiple instances of jobd running on multiple
   hosts. Each jobd instance may have unlimited number of queues (called "targets"),
   each with its own concurrency limit.

2. **jobd-master** is a "master" or "cetral" daemon that simplifies control over
   many jobd instances. There should be only one instance of jobd-master running.
   jobd-master is not required for jobd workers to work (they can work without it),
   but it's very very useful.
   
In addition, there is a command line utility called **jobctl**.

Originally, jobd was created as a saner alternative to Gearman. It's been used
in production with a large PHP web application on multiple servers for quite some
time already, and proven to be stable and efficient.

## Table of Contents

- [How it works](#how-it-works)
- [Protocol](#protocol)
  - [Request Message](#request-message)
    - [jobd request types](#jobd-request-types)
    - [jobd-master request types](#jobd-master-request-types)
  - [Response Message](#response-message)
  - [Ping and Pong Messages](#ping-and-pong-messages)
- [Implementation example](#implementation-example)
- [Installation](#installation)
- [Usage](#usage)
  - [systemd](#systemd)
  - [supervisor](#supervisor)
  - [Other notes](#other-notes)
- [Configuration](#configuration)
  - [jobd](#jobd)
  - [jobd-master](#jobd-master)
  - [jobctl](#jobctl)
- [MySQL setup](#mysql-setup)
- [Clients](#clients)
  - [PHP](#php)
- [TODO](#todo)
- [License](#license)


## How it works

To be written.

## Protocol

By default, jobd and jobd-master listen on TCP ports 7080 and 7081 respectively,
ports can be changed in a config.

jobd has been created with an assumption that it'll be used in more-or-less
trusted environments (LAN, or, at least, servers within one data center) so no
encryption nor authentication mechanisms have been implemented. All traffic
between jobd and clients flow in plain text. You can protect a jobd instance with
a password though, so at least basic password-based authorization is supported.

Both daemons receive and send Messages. Each message is followed by `EOT` (`0x4`)
byte which indicates an end of a message. Clients may send and receive multiple
messages over a single connection. Usually, it's the client who must close the
connection, when it's not needed anymore. A server, however, may close the
connection in some situations (invalid password, server error, etc).

Messages are encoded as JSON arrays with at least one item, representing
the message type:
```
[TYPE]
```

If a message of specific type has some data, it's placed as a second item:
```
[TYPE, DATA]
```

Type of `TYPE` is integer. Supported types are:

- `0`: Request
- `1`: Response
- `2`: Ping
- `3`: Pong


### Request Message

`DATA` is a JSON object with following keys:

- **`no`** *(**required**, int)* — unique (per connection) request number. Clients
  can start counting request numbers from one (`1`) or from any other random number.
  Each subsequent request should increment this number by 1. Note that zero (`0`)
  is reserved.
- **`type`** *(**required**, string)* — request type. Supported request types for
  jobd and jobd-master are listed below.
- **`data`** *(object)* — request arguments (if needed): an object, whose keys
  and values represent argument names and values.
- **`password`** *(string)* — a password, for password-protected instances. Only
  needed for first request.
  
Example (w/o trailing `EOT`):
```
[0,{no:0,type:'poll',data:{'targets':['target_1','target_2']}}]
```

Here is the list of supported requests, using `type(arguments)` notation.

#### jobd request types

* **`poll(targets: string[])`** — get new tasks for specified `targets` from database.
  If `targets` argument is not specified, get tasks for all serving targets.

* **`pause(targets: string[])`** — pause execution of tasks of specified targets.
  If `targets` argument is not specified, pauses all targets.

* **`continue(targets: string[])`** — continue execution of tasks of specified targets.
  If `targets` argument is not specified, continues all targets.

* **`status()`** — returns status of internal queues and memory usage.

* **`run-manual(ids: int[])`** — enqueue and run jobs with specified IDs and
  `status` set to `manual`, and return results.

* **`add-target(target: string, concurrency: int)`** — add target

* **`remove-target(target: string, concurrency: int)`** — remove target

* **`set-target-concurrency(target: string, concurrency: int)`** — set concurrency
  of target `target`.

#### jobd-master request types

* **`register-worker(targets: string[])`** — used by a jobd instance to register
  itself with master. You don't need it.

* **`poke(targets: string[])`** — send `poll` requests to all registered workers
  that serve specified `targets`.

* **`pause(targets: string[])`** — send `pause(targets)` requests to workers
  serving specified `targets`. If `targets` argument is not specified, sends
  `pause()` to all workers.

* **`continue(targets: string[])`** — send `continue(targets)` requests to workers
  serving specified `targets`. If `targets` argument is not specified, sends
  `continue()` to all workers.

* **`status(poll_workers=false: bool)`** — returns list of registered workers and
  memory usage. If `poll_workers` is true, sends `status()` request to all registered
  workers and includes their responses.

* **`run-manual(jobs: {id: int, target: string}[])`** — send `run-manual`
  requests to registered jobd instances serving specified targets, aggregate an
  return results.
  
### Response Message

`DATA` is a JSON object with following keys:

- **`no`** *(**required**, int)* — `no` of request this response is related to.
- **`data`** *(array *|* object *|* string *|* int)* — data, if request succeeded.
- **`error`** *(string)* — error message, if request failed.

Example (w/o trailing `EOT`):
```
[1,{no:0,data:'ok'}]
```

### Ping and Pong Messages

No `DATA`.

Example (w/o trailing `EOT`):
```
[2]
```

## Implementation example

To be written.

## Installation

First, you need Node.JS 14 or newer. See [here](https://nodejs.org/en/download/package-manager/)
now to install it using package manager.

Then install jobd using npm:

```
npm i -g jobd 
```


## Usage

### systemd

One of possible ways of launching jobd and jobd-master daemons is via systemd.
This repository contains basic examples of `jobd.service` and `jobd-master.service`
unit files. Note that jobs will be launched as the same user the jobd worker is
running, so you might want to change that.

Copy `.service` file(s) to `/etc/systemd/system`, then do:
```
systemctl daemon-reload
systemctl enable jobd
systemctl start jobd
# repeat last two steps for jobd-master, if needed
```

### supervisor

If you don't like systemd, supervisor might be an option. Create a configuration
file in `/etc/supervisor/conf.d` with following content:
```
[program:jobd]
command=/usr/bin/jobd --config /etc/jobd.conf
numprocs=1
directory=/
stdout_logfile=/var/log/jobd-stdout.log
autostart=true
autorestart=true
user=nobody
stopsignal=TERM
```

Then use `supervisorctl` to start or stop jobd.


### Other notes

Don't forget to filter access to jobd and jobd-master ports using your favorite
firewall.

## Configuration

Configuration files are written in ini format. All available options for both
daemons, as well as a command-line utility, are described below. You can copy
`jobd.conf.example` and `jobd-master.conf.example` and use them as a template
instead of writing configs from scratch.

### jobd

Default config path is `/etc/jobd.conf`. Use the `--config` option to use
a different path.

Without section:

- **`host`** *(required, string)* — jobd server hostname 
- **`port`** *(required, int)* — jobd server port
- **`password`** *(string)* — password for requests
- **`always_allow_localhost`** *(boolean, default: `false`)* — when set to `1`
  or `true`, allows accepting requests from clients connecting from localhost
  without password
- **`master_host`** *(string)* — master hostname
- **`master_port`** *(int)* — master port. If hostname or port is omitted, jobd
  will not connect to master.
- **`master_reconnect_timeout`** *(int, default: `10`)* — if connection to master
  failed, jobd will be constantly trying to reconnect. This option specifies a
  delay between connection attempts, in seconds.
- **`log_file`** *(string)* — path to a log file
- **`log_level_file`** *(string, default: `warn`)* — minimum level of logs that
  are written to the file.<br>
  Allowed values: `trace`, `debug`, `info`, `warn`, `error`
- **`log_level_console`** *(string, default: `warn`)* — minimum level of logs
  that go to stdout.
- **`mysql_host`** *(required, string)* — database host
- **`mysql_port`** *(required, int)* — database port
- **`mysql_user`** *(required, string)* — database user
- **`mysql_password`** *(required, string)* — database password
- **`mysql_database`** *(required, string)* — database name
- **`mysql_table`** *(required, string)* — table name
- **`mysql_fetch_limit`** *(int, default: `100`)* — a number of new jobs to fetch
  in every request
- **`launcher`** *(required, string)* — a template of shell command that will be launched
  for every job. `{id}` will be replaced with job id
- **`max_output_buffer`** *(int, default: `1048576`)*

Under the `[targets]` section, targets are specified. Each target is specified on
a separate line in the following format:
```
{target_name} = {n}
```
where:
- `{target_name}` *(string)* is target name
- `{n}` *(int)* is maximum count of simultaneously executing jobs for this target

### jobd-master

Default config path is `/etc/jobd-master.conf`. Use the `--config` option to use
a different path.

- **`host`** *(required, string)*
- **`port`** *(required, int)*
- **`password`** *(string)*
- **`always_allow_localhost`** *(boolean, default: `false`)*
- **`ping_interval`** *(int, default: `30`)* — specifies interval between workers
  pings.
- **`poke_throttle_interval`** *(int, default: `0.5`)*
- **`log_file`** *(string)*
- **`log_level_file`** *(string, default: `warn`)* 
- **`log_level_console`** *(string, default: `warn`)*

### jobctl

Default config path is `~/.jobctl.conf`.

- **`master`** (boolean) — same as `--master`.
- **`host`** *(string)* — same as `--host`.
- **`port`** *(int)* — same as `--port`.
- **`password`** *(string)*
- **`log_level`** *(string, default: `warn`)*

## MySQL setup

Minimal table scheme:

```
CREATE TABLE `jobs` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `target` char(16) NOT NULL,
  `time_created` int(10) UNSIGNED NOT NULL,
  `time_started` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `time_finished` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `status` enum('waiting','manual','accepted','running','done','ignored') NOT NULL DEFAULT 'waiting',
  `result` enum('ok','fail') DEFAULT NULL,
  `return_code` tinyint(3) UNSIGNED DEFAULT NULL,
  `sig` char(10) DEFAULT NULL,
  `stdout` mediumtext DEFAULT NULL,
  `stderr` mediumtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `status_target_idx` (`status`, `target`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
```

In a real world, you need some additional fields such as `job_name` or `job_data`.

For optimization purposes, you can turn `target` into `ENUM`. Also, if 16 characters
for the `target` field is not enough for you, change it to fit your needs.


## Clients

### PHP

[php-jobd-client](https://github.com/gch1p/php-jobd-client) (official)

## TODO

- graceful shutdown

## License

BSD-2c