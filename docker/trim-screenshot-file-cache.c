#define _XOPEN_SOURCE 700

#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int failed;

static int trim_file(const char *path, const struct stat *info, int type,
                     struct FTW *position) {
    (void)position;
    if (type != FTW_F || !S_ISREG(info->st_mode)) {
        return 0;
    }

    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    int error;
    if (fd == -1) {
        error = errno;
    } else {
        error = posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
        close(fd);
    }
    if (error != 0) {
        fprintf(stderr, "%s: %s\n", path, strerror(error));
        failed = 1;
    }
    return 0;
}

static void trim_path(const char *path) {
    if (nftw(path, trim_file, 16, FTW_PHYS) == -1) {
        perror(path);
        failed = 1;
    }
}

int main(int argc, char *argv[]) {
    for (int index = 1; index < argc; index++) {
        trim_path(argv[index]);
    }
    // Chromium and Fontconfig also read files outside the browser install.
    trim_path("/usr/share/fonts");
    trim_path("/var/cache/fontconfig");
    trim_path(SYSTEM_LIBRARY_DIR);
    return failed;
}
