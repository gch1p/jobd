# jobd

**jobd** is a simple job queue daemon written in Node.JS. It uses MySQL table as
a storage.


## Installation

To be written


## Usage

To be written


## MySQL setup

Minimal table scheme.

In a real world, you would to add need additional fields such as `job_name` or
`job_data`. 

```
CREATE TABLE `jobs` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `target` char(16) NOT NULL,
  `slot` char(16) DEFAULT NULL,
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

For optimization purposes, you can turn fields `target` and `slot` into `ENUM`s.


## TODO

**jobd**:
- `pause(targets)` / `continue(targets)`
- `runManual` with multiple jobs

**jobd-master**:
- `status(workers=true)`
- `pause(targets)` / `continue(targets)`

both:
- text protocol
- graceful shutdown
- remove password from logger dumps


## License

BSD-2c