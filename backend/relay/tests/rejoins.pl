# A process that a command's group's first SIGKILL passes over, as XNU's killpg(2) passes
# over one still being forked, and that is in the group again just after: it leaves the
# group, says so (it prints "partly" and makes the file `left`), and once the shell that
# started it has ended rejoins it, then after `later` seconds makes the file `mark`, with
# its pid, parent and group, which only a SIGKILL sent again stops. A child of its own
# that it never reaps keeps the group there for it to rejoin, as the shell's own end
# doesn't wait for anything to reap it; should the group be gone anyway, it makes nothing.
use strict;
use POSIX ();
my ($left, $mark, $later) = @ARGV;
my ($group, $parent) = (getpgrp(), getppid());
my $child = fork();
defined $child or exit;
POSIX::_exit(0) if $child == 0;
setpgrp(0, 0) or exit;
$| = 1;
print "partly";
open(my $file, ">", $left) or exit;
close $file;
select(undef, undef, undef, 0.001) while getppid() == $parent;
setpgrp(0, $group) or exit;
select(undef, undef, undef, $later);
open($file, ">", $mark) or exit;
print $file "pid $$, parent ", getppid(), ", group ", getpgrp(), "\n";
close $file;
