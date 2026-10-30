cask "prismagram" do
  arch arm: "aarch64", intel: "x64"

  version "0.4.0"
  sha256 arm:   "541c0a9e4f4520b2bd44e363a3a96e45023657239fa339e03049c49169cc1e75",
         intel: "322d796083cbd0d6e0fd0b3b866b7da2e9e1fcf0b265c0a725dbdff41b9060cb"

  url "https://github.com/Kingvic300/Prismagram/releases/download/v#{version}/Prismagram_#{version}_#{arch}.dmg"
  name "Prismagram"
  desc "Prisma schema diagrams and a database client"
  homepage "https://kingvic300.github.io/Prismagram/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "Prismagram.app"

  zap trash: "~/Library/Application Support/io.github.kingvic300.prismagram"

  caveats <<~EOS
    Prismagram is not code-signed yet. If macOS says it cannot be opened, run:
      xattr -dr com.apple.quarantine "#{appdir}/Prismagram.app"
  EOS
end
