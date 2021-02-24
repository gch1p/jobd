# jobd

**jobd** is a simple job queue daemon written in Node.JS. It uses MySQL
table as a storage.


## Installation

To be written


## Usage

To be written


## MySQL setup

Table scheme. You can add additional fields if you need.

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

You can turn `target` and `slot` to `ENUM`, for optimization.

## License

BSD-2c