# jobd

**jobd** is a simple job queue daemon that works with persistent queue storage.
It uses a MySQL table as a storage backend (for queue input and output).

Currently, MySQL is the only supported storage. Other backends may be easily
supported though.

It is by design that jobd never adds nor deletes jobs from storage. It only
reads (when a certain request arrives) and updates them (during execution, when
job status changes). Succeeded or failed, your jobs are never lost.

jobd consists of 2 parts:

1. **jobd** is a "worker" daemon that reads jobs from the database, enqueues and
   launches them. There may be multiple instances of jobd running on multiple
   hosts. Each jobd instance may have unlimited number of queues (called "targets"),
   each with its own concurrency limit.

2. **jobd-master** is a "master" or "central" daemon that simplifies control over
   many jobd instances. There should be only one instance of jobd-master running.
   jobd-master is not required for jobd workers to work (they can work without it),
   but it's very very useful.
   
In addition, there is a command line utility called **jobctl**.

Originally, jobd was created as a saner alternative to Gearman. It's been used
in production with a large PHP web application on multiple servers for quite some
time already, and proven to be stable and efficient.

## Table of Contents

- [How it works](#how-it-works)
    - [Targets](#targets)
    - [Creating jobs](#creating-jobs)
    - [Launching jobs](#launching-jobs)
    - [Launching background jobs](#launching-background-jobs)
    - [Launching manual jobs](#launching-manual-jobs)
    - [Using jobd-master](#using-jobd-master)
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
- [Clients](#clients)
    - [PHP](#php)
- [Protocol](#protocol)
    - [Request Message](#request-message)
        - [jobd requests](#jobd-requests)
            - [poll(targets: string[])](#polltargets-string)
            - [pause(targets: string[])](#pausetargets-string)
            - [continue(targets: string[])](#continuetargets-string)
            - [status()](#status)
            - [run-manual(ids: int[])](#run-manualids-int)
            - [add-target(target: string, concurrency: int)](#add-targettarget-string-concurrency-int)
            - [remove-target(target: string)](#remove-targettarget-string)
            - [set-target-concurrency(target: string, concurrency: int)](#set-target-concurrencytarget-string-concurrency-int)
        - [jobd-master requests](#jobd-master-requests)
            - [register-worker(targets: string[])](#register-workertargets-string)
            - [poke(targets: string[])](#poketargets-string)
            - [pause(targets: string[])](#pausetargets-string-1)
            - [continue(targets: string[])](#continuetargets-string-1)
            - [status(poll_workers=false: bool)](#statuspoll_workersfalse-bool)
            - [run-manual(jobs: {id: int, target: string}[])](#run-manualjobs-id-int-target-string)
    - [Response Message](#response-message)
    - [Ping and Pong Messages](#ping-and-pong-messages)
- [TODO](#todo)
- [License](#license)


## How it works

### Targets

Every jobd instance has its own set of queues, called **targets**. A name of a
target is an arbitrary string, the length of which should be limited by the size
of `target` field in the MySQL table.

Each target has its own concurrency limit (the maximum number of jobs that may
be executed simultaneously). Targets are loaded from the config at startup, and
also may be added or removed at runtime, by
[`add-target(target: string, concurrency: int)`](#add-targettarget-string-concurrency-int)
and [`remove-target(target: string)`](#remove-targettarget-string) requests.

The purpose of targets is to logically separate jobs of different kinds by putting
them in different queues. For instance, targets can be used to simulate jobs
priorities:
```ini
[targets]
low = 5
normal = 5
high = 5 
```

The config above defines three targets (or three queues), each with a concurrency
limit of `5`.

Or, let's imagine a scenario when you have two kinds of jobs: heavy,
resource-consuming, long-running jobs (like video processing) and light, fast
and quick jobs (like sending emails). In this case, you could define two targets,
like so:
```ini
[targets]
heavy = 3
quick = 20
```

This config would allow you to run at most 3 heavy and up to 20 quick jobs
simultaneously.

> :thought_balloon: The approach of having different targets (queues) for different kinds
> of jobs is better than having a single queue with each job having a "priority".
> 
> Imagine you had a single queue with maximum number of simultaneously running
> jobs set to, say, 20. What would happen if you'd add a new job, even with the
> highest priority possible, if there's already 20 slow jobs running? No matter
> how high the priority of new job is, it would have to wait.
>
> By defining different targets, jobd allows you to create dedicated queues for
> such jobs, making sure there's always a room for high-priority tasks to run
> them as early as possible.

### Creating jobs

Each job is described by one record in the MySQL table. Here is a table scheme
with a minimal required set of fields:
```mysql
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

As you can see:
1.  Each job has a unique ID. You don't need to care about assigning IDs because 
    `AUTO_INCREMENT` is used.
2.  Each job is associated with some target, or, in other words, is put to
    some queue. More about targets in the [Targets](#targets) section.
3.  There are `time_created`, `time_started` and `time_finished` fields, and it's 
    not hard to guess what their meaning. When creating a job, you should fill
    the `time_created` field with a UNIX timestamp. jobd will update the two other
    fields while executing the job.
4.  Each job has a `status`.
    - A job must be created with status set to `waiting` or `manual`.
    - A status becomes `accepted` when jobd reads the job from the table and
    puts it to a queue, or it might become `ignored` in case of some error, like
      invalid `target`, or invalid `status` when processing a [run-manual(ids: int)](#run-manualids-int)
      request.
    - Right before a job is getting started, its status becomes `running`.<br>
    - Finally, when it's done, it is set to `done`.
5.  The `result` field indicates whether a job completed successfully or not.
    - It is set to `ok` if the return code of launched command was `0`.
    - Otherwise, it is set to `fail`.
6.  The `return_code` field is filled with the actual return code.
7.  If the job process was killed by a POSIX signal, the signal name is written
    to the `sig` field.
8.  stdout and stderr of the process are written to `stdout` and `stderr` fields,
    accordingly.
    
> :bulb: Maybe you noticed that there are no `priority` field and wonder how to create
> jobs with different priorities. Indeed, jobd doesn't support "priorities".
> Instead, you should create different targets for jobs of different priorities
> and assign your jobs to corresponding targets. Learn more about it in the
> [Targets](#targets) section.
    
> :warning: In a real world, you'll want to have a few more additional fields,
> like `job_name` or `job_data`.<br>
> Check out the [implementation example](#implementation-example).

To create a new job (or multiple jobs), they must be added to the table. As mentioned
earlier, adding or removing to/from the table is outside the jobd's area of
responsibility and this is by design. User must add jobs to the table manually.

There are two kinds of jobs, in terms of how they are executed: **background** and
**manual** (foreground).

* Background jobs are created with `waiting` status. When jobd gets new
  jobs from the table (after receiving a [`poll(target: strings[])`](#polltargets-string)
  request: this process is described in the [launching background jobs](#launching-background-jobs)
  section), such jobs are added to their queues and are executed at some point,
  depending on the current queue status and concurrency limit. User does not
  have control of the execution flow, the only feedback it has over the job
  executing is the fields in the table that are updated during the execution. At
  some point, `status` will become `done`, `result` and other fields will have
  their values filled too, and that's it.
* Manual, or foreground jobs, is a different story. They must be created with
  `status` set to `manual`. These jobs are processed only upon a 
  [`run-manual(ids: int[])`](#run-manualids-int) request. When jobd receives such
  request, it reads and launches the specified jobs, waits for the results and
  sends them back to the client in a response.

### Launching jobs

**Launching** (or **executing**) a job means **running a command** specified in
the config as the `launcher`, replacing the `{id}` template with current job id.

For example, if you have this in the config:
```
launcher = php /home/user/job-launcher.php {id}
```
and jobd is currently executing a job with id 123, it will launch
`php /home/user/job-launcher.php 123`.

### Launching background jobs

After jobs have been added to storage, jobd must be notified about it. This is 
done by a [`poll(targets: string[])`](#polltargets-string) request that a user (a client) sends to the
jobd instance. The `targets` argument is an array (a list) of `targets` to poll.
It can be omitted; in that case jobd will query for jobs for all targets it is
serving.

When jobd receives a [`poll(targets: string[])`](#polltargets-string) request and specified targets are
not full (haven't reached their concurrency limit), it performs a `SELECT` query
with `status='manual'` condition and `LIMIT` set according to the `mysql_fetch_limit`
config value.

For example, after receiving the [`poll(['1/low', '1/normal'])`](#polltargets-string) request, assuming
`mysql_fetch_limit` is set to `100`, jobd will query jobs roughly like this:
```mysql
SELECT id, status, target FROM jobs WHERE status='manual' AND target IN ('1/low', '1/normal') ORDER BY id LIMIT 0, 100 FOR UPDATE
```
However, if all specified targets are full at the time of jobd receiving the
[`poll(targets: string[])`](#polltargets-string) request, the query will be delayed until at least one
of the targets becomes available for new jobs.

### Launching manual jobs

To be written.

### Using jobd-master

To be written.

```
Fig. 1

┌────────┐   ┌────────┐   ┌────────┐
│  jobd  │   │  jobd  │   │  jobd  │
└───┬────┘   └────┬───┘   └────┬───┘
    │             │            │
    │     ┌───────▼───────┐    │
    └────►│  jobd-master  │◄───┘
          └───────────────┘
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
This repository contains basic examples of [`jobd.service`](systemd/jobd.service)
and [`jobd-master.service`](systemd/jobd-master.service) unit files. Note that 
jobs will be launched as the same user the jobd worker is running, so you might
want to change that.

Copy `.service` file(s) to `/etc/systemd/system`, then do:
```shell
systemctl daemon-reload
systemctl enable jobd
systemctl start jobd
# repeat last two steps for jobd-master, if needed
```

### supervisor

If you don't like systemd, [supervisor](http://supervisord.org/) might be an
option. Create a configuration file in `/etc/supervisor/conf.d` with following
content:
```ini
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

:exclamation: Don't forget to filter access to jobd and jobd-master ports using
a firewall. See a note [here](#protocol) for more info.

## Configuration

Configuration files are written in ini format. All available options for both
daemons, as well as a command-line utility, are described below. You can copy
[`jobd.conf.example`](jobd.conf.example) and [`jobd-master.conf.example`](jobd-master.conf.example)
and use them as a template instead of writing configs from scratch.

### jobd

Default config path is `/etc/jobd.conf`. Use the `--config` option to use
a different path.

Without section:

- `host` *(required, string)* — jobd server hostname 
- `port` *(required, int)* — jobd server port
- `password` *(string)* — password for requests
- `always_allow_localhost` *(boolean, default: `false`)* — when set to `1`
  or `true`, allows accepting requests from clients connecting from localhost
  without password
- `master_host` *(string)* — master hostname
- `master_port` *(int)* — master port. If hostname or port is omitted, jobd
  will not connect to master.
- `master_reconnect_timeout` *(int, default: `10`)* — if connection to master
  failed, jobd will be constantly trying to reconnect. This option specifies a
  delay between connection attempts, in seconds.
- `log_file` *(string)* — path to a log file
- `log_level_file` *(string, default: `warn`)* — minimum level of logs that
  are written to the file.<br>
  Allowed values: `trace`, `debug`, `info`, `warn`, `error`
- `log_level_console` *(string, default: `warn`)* — minimum level of logs
  that go to stdout.
- `mysql_host` *(required, string)* — database host
- `mysql_port` *(required, int)* — database port
- `mysql_user` *(required, string)* — database user
- `mysql_password` *(required, string)* — database password
- `mysql_database` *(required, string)* — database name
- `mysql_table` *(required, string)* — table name
- `mysql_fetch_limit` *(int, default: `100`)* — a number of new jobs to fetch
  in every request
- `launcher` *(required, string)* — a template of shell command that will be launched
  for every job. `{id}` will be replaced with job id
- `max_output_buffer` *(int, default: `1048576`)*

Under the `[targets]` section, targets are specified. Each target is specified on
a separate line in the following format:
```ini
{target_name} = {n}
```
where:
- `{target_name}` *(string)* is target name
- `{n}` *(int)* is maximum count of simultaneously executing jobs for this target

### jobd-master

Default config path is `/etc/jobd-master.conf`. Use the `--config` option to use
a different path.

- `host` *(required, string)*
- `port` *(required, int)*
- `password` *(string)*
- `always_allow_localhost` *(boolean, default: `false`)*
- `ping_interval` *(int, default: `30`)* — specifies interval between workers
  pings.
- `poke_throttle_interval` *(int, default: `0.5`)*
- `log_file` *(string)*
- `log_level_file` *(string, default: `warn`)* 
- `log_level_console` *(string, default: `warn`)*

### jobctl

Default config path is `~/.jobctl.conf`.

- `master` (boolean) — same as `--master`.
- `host` *(string)* — same as `--host`.
- `port` *(int)* — same as `--port`.
- `password` *(string)*
- `log_level` *(string, default: `warn`)*

## Clients

### PHP

[php-jobd-client](https://github.com/gch1p/php-jobd-client) (official)

## Protocol

By default, jobd and jobd-master listen on TCP ports 7080 and 7081 respectively,
ports can be changed in a config.

> :exclamation: jobd has been created with an assumption that it'll be used in
> more-or-less trusted environments (like LAN or, at least, servers within one
> data center) so **no encryption nor authentication mechanisms have been
> implemented.** All traffic between jobd and clients flow **in plain text**.
> 
> You can protect a jobd instance with a password though, so at least basic
> password-based authorization is supported.

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

- ##### `no` (required, int)
  Unique (per connection) request number. Clients can start counting request
  numbers from one (`1`) or from any other random number. Each subsequent request
  should increment this number by 1. Note that zero (`0`) is reserved.
  
- ##### `type` (required, string)
  Request type. Supported request types for [jobd](#jobd-requests) and
  [jobd-master](#jobd-master-requests) are listed below.
  
- ##### `data` (object)
  Request arguments (if needed): an object, whose keys and values represent
  argument names and values.
  
- ##### `password` (string)
  A password, for password-protected instances. Only needed for first request.

Example (w/o trailing `EOT`):
```
[0,{no:1,type:'poll',data:{'targets':['target_1','target_2']}}]
```

Here is the list of supported requests, using `type(arguments)` notation.

#### jobd requests

* ##### `poll(targets: string[])`
  Get new tasks for specified `targets` from database. If `targets` argument is
  no specified, get tasks for all serving targets.
  
  Response [data](#data-array--object--string--int) type: **string** ('ok').

* ##### `pause(targets: string[])`
  Pause execution of tasks of specified targets. If `targets` argument is
  omitted, pauses all targets.

  Response [data](#data-array--object--string--int) type: **string** ('ok').

* ##### `continue(targets: string[])`
  Continue execution of tasks of specified targets. If `targets` argument is
  omitted, continues all targets.

  Response [data](#data-array--object--string--int) type: **string** ('ok').

* ##### `status()`
  Returns status of internal queues and memory usage.
  
  Response [data](#data-array--object--string--int) type: **object** with following keys:
  - `targets` (object<target: string, {paused: bool, concurrency: int, length: int}>)
  - `jobPromisesCount` (int)
  - `memoryUsage` (NodeJS.MemoryUsage)

* ##### `add-target(target: string, concurrency: int)`
  Add target.

  Response [data](#data-array--object--string--int) type: **string** ('ok').

* ##### `remove-target(target: string)`
  Remove target.

  Response [data](#data-array--object--string--int) type: **string** ('ok').

* ##### `set-target-concurrency(target: string, concurrency: int)`
  Set concurrency limit of target `target`.

  Response [data](#data-array--object--string--int) type: **string** ('ok').

* ##### `run-manual(ids: int[])`
  Enqueue and run jobs with specified IDs and `status` set to `manual`, and
  return results.

  Response [data](#data-array--object--string--int) type: **object** with following keys:
  - `jobs` (object<int, object>)
    
    An object whose keys represent succeeded job IDs and whose values are objects
    with following keys:
    - `result` (string)
    - `code` (int)
    - `signal` (string|null)
    - `stdout` (string)
    - `stderr` (string)
  - `errors` (object<int, string>)
    An object whose keys represent failed job IDs and whose values are error
    messages.

#### jobd-master requests

* ##### `register-worker(targets: string[])`
  Used by a jobd instance to register  itself with master. Clients don't need it.

* ##### `poke(targets: string[])`
  Send [`poll(targets)`](#polltargets-string) requests to all registered workers that serve specified
  `targets`.

* ##### `pause(targets: string[])`
  Send [`pause(targets)`](#pausetargets-string) requests to workers serving
  specified `targets`. If `targets` argument is omitted, sends [`pause()`](#pausetargets-string)
  to all workers.

* ##### `continue(targets: string[])`
  Send [`continue(targets)`](#continuetargets-string) requests to workers serving
  specified `targets`. If `targets` argument is omitted, sends
  [`continue()`](#continuetargets-string) to all workers.

* ##### `status(poll_workers=false: bool)`
  Returns list of registered workers and memory usage. If `poll_workers` argument
  is true, sends [`status()`](#status) request to all workers and includes their responses.

* ##### `run-manual(jobs: {id: int, target: string}[])`
  Send [`run-manual()`](#run-manualids-int) requests to registered jobd instances
  serving specified targets, aggregate and return results.

### Response Message

`DATA` is a JSON object with following keys:

- ##### `no` (required, int)
  [`no`](#no-required-int) of request this response is related to.
  
- ##### `data` (array | object | string | int)
  Data, if request succeeded.
  
- ##### `error` (string)
  Error message, if request failed.

Example (w/o trailing `EOT`):
```
[1,{no:1,data:'ok'}]
```

### Ping and Pong Messages

No `DATA`.

Example (w/o trailing `EOT`):
```
[2]
```

## TODO

- graceful shutdown

## License

BSD-2c
