# Parser fixtures

Sample output of the commands Open HR reads, used by the parser and state
reader tests. Each folder is one machine or one topic.

| Folder          | Origin                                                                                                                                                      | What it shows                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `virtio-vm/`    | **Real**, captured from a cloud VM with util-linux 2.39.3, LVM 2.03.16, and smartmontools 7.4. Mount paths of unrelated tools were renamed to generic ones. | `lsblk` and `findmnt` on a machine with virtio disks and no RAID, an empty `pvs` report, and smartctl failing on a disk it cannot identify.                      |
| `vm-shr1/`      | **Real**, captured from a Debian 13 VM with util-linux 2.41.5, mdadm 4.4, LVM 2.03.31, and smartmontools 7.4. Versions are in `versions.txt`.                  | An SHR-1 pool `dev` built by hand on QEMU disks of 2, 4, 4, 6, 8, and 8 GiB: four arrays, one volume group, a btrfs volume. `mdstat-resync.txt` is the initial build. |
| `example-shr1/` | **Synthesized** from the documented formats. Sizes are consistent across every file.                                                                        | The worked example in the plan: an NVMe system drive and 4, 8, and 8 TB data drives in SHR-1, with a btrfs volume. Also smartctl reports for a healthy drive, a failing drive, and a drive left asleep. |
| `mdstat/`       | **Synthesized** from the kernel's documented format.                                                                                                        | `/proc/mdstat` in degraded, recovering, delayed, reshaping, checking, spare, inactive, and read-only states.                                                     |

Synthesized fixtures are a stand-in until real output replaces them. The
container these were written in has no md or device-mapper support, so
`mdadm`, `/proc/mdstat`, and LVM output could not be captured there.

## Replacing them with real output

Run `scripts/capture-fixtures.sh` on a Debian or Proxmox machine or VM with
an SHR layout built by hand. It only reads, never writes to a drive, and puts
everything in one folder. Review the files for anything private, such as
serial numbers or hostnames, before committing them.
